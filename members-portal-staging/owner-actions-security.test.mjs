import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,epoch,envConfig,token} from '../portal/test-support.mjs';
import {prepareOwnerAction,executeOwnerAction,ownerActionCookie} from '../portal/owner-member-actions.mjs';
import {createRepository} from '../portal/repository.mjs';

test('action cannot mutate D1 after session expiry while nonce query is pending',async t=>{
 const {db}=await fixture(t);
 let at=epoch;
 const origin=envConfig.APP_ORIGIN,session=token();
 const base=new Request(origin+'/app/manage',{headers:{'Cf-Access-Jwt-Assertion':session}});
 const csrf=await prepareOwnerAction(db,base,'owner',epoch+1,()=>at);
 const delayed={
  prepare(sql){
   const statement=db.prepare(sql);
   if(sql.startsWith('UPDATE owner_action_nonces'))return {bind(...params){
    const bound=statement.bind(...params);
    return {async first(){const value=await bound.first();at=epoch+2;return value;}};
   }};
   return statement;
  },
  batch:(...params)=>db.batch(...params)
 };
 const request=new Request(origin+'/app/manage',{
  method:'POST',
  headers:{'Cf-Access-Jwt-Assertion':session,Origin:origin,
   Cookie:ownerActionCookie+'='+csrf,'Content-Type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({csrf,action:'create',contact:'expired@example.test'})
 });
 await assert.rejects(executeOwnerAction(delayed,request,'owner',epoch+1,()=>at));
 assert.equal((await db.prepare("SELECT count(*) AS n FROM members").first()).n,1);
 assert.equal((await db.prepare("SELECT count(*) AS n FROM invitations").first()).n,0);
});

test('database clock enforces JWT deadline at every Owner D1 mutation',async t=>{
 const {db,repo}=await fixture(t);
 const cutoff=Math.floor(Date.now()/1000)-1;
 const staleClock=()=>cutoff-2;
 const guarded=createRepository(db,{now:staleClock,sessionExpiresAt:cutoff});
 const count=async table=>(await db.prepare('SELECT count(*) AS n FROM '+table).first()).n;
 const before=await count('members');
 await assert.rejects(guarded.createPending('owner','too-late@example.test'));
 assert.equal(await count('members'),before);
 assert.equal(await count('audit_events'),0);

 const id=await repo.createPending('owner','allowed@example.test');
 await assert.rejects(guarded.issue('owner',id,{expectedPredecessorId:null}));
 assert.equal(await count('invitations'),0);
 const issued=await repo.issue('owner',id);
 await assert.rejects(guarded.cancelInvitation('owner',issued.id));
 const status=await db.prepare('SELECT status,digest FROM invitations WHERE id=?').bind(issued.id).first();
 assert.equal(status.status,'blocked');
 assert.match(status.digest,/^[0-9a-f]{64}$/);
});

test('explicit invitation predecessor prevents stale issue and reissue',async t=>{
 const {db,repo}=await fixture(t);
 const member=await repo.createPending('owner','stale@example.test');
 const first=await repo.issue('owner',member,{expectedPredecessorId:null});
 await assert.rejects(repo.issue('owner',member,{expectedPredecessorId:null}));
 const second=await repo.issue('owner',member,{expectedPredecessorId:first.id});
 await assert.rejects(repo.issue('owner',member,{expectedPredecessorId:first.id}));
 const rows=(await db.prepare('SELECT revision,status FROM invitations WHERE member_id=? ORDER BY revision').bind(member).all()).results;
 assert.equal(rows.length,2);
 assert.deepEqual(rows.map(row=>row.status),['superseded','blocked']);
 assert.ok(second.id!==first.id);
});
