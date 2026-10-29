import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,epoch,envConfig,token} from '../portal/test-support.mjs';
import {prepareOwnerAction,executeOwnerAction,ownerActionCookie} from '../portal/owner-member-actions.mjs';

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
