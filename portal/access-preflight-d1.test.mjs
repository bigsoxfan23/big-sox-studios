import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,epoch} from './test-support.mjs';
import {desiredProjection} from './projection.mjs';
import {preflightAccessProjection} from './access-preflight.mjs';

const api = result => ({success:true,errors:[],messages:[],result,result_info:{page:1,per_page:100,count:result.length,total_count:result.length,total_pages:1}});
async function snapshot(f) {
 const {results:members} = await f.db.prepare(`SELECT m.id,m.recipient,m.status,i.id AS invitationId,i.status AS invitationStatus,i.expires_at AS expiresAt
 FROM members m LEFT JOIN invitations i ON i.member_id=m.id AND i.revision=(SELECT max(revision) FROM invitations WHERE member_id=m.id) ORDER BY m.id`).all();
 return {capturedAt:f.now(),complete:true,members};
}
function input(d1Before,contacts,now=epoch) {
 return {now,expectedHosts:['members.example.test'],expectedIdps:['synthetic-idp'],
  hosts:{capturedAt:now,complete:true,workersDev:false,previewUrls:false,hosts:['members.example.test']},
  access:{capturedAt:now,complete:true,applications:api([{id:'synthetic-app',type:'self_hosted',domain:'members.example.test',allowed_idps:['synthetic-idp']}]),groups:api([]),
   policies:[{applicationId:'synthetic-app',response:api([{id:'synthetic-policy',decision:'allow',precedence:1,include:contacts.map(email=>({email:{email}})),require:[{login_method:{id:'synthetic-idp'}}],exclude:[]}])}]},
  d1Before,d1After:structuredClone(d1Before)};
}

test('OFFLINE D1 preflight: desiredProjection agreement, expiry boundary and revoked stale contact',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.ready(id);
 const identity=await f.identity();
 let desired=await desiredProjection(f.db,epoch);
 let data=input(await snapshot(f),desired.map(x=>x.recipient));
 assert.equal(preflightAccessProjection(data).reconciliation,'CONTACTS_MATCH_ONLY');
 f.time(invite.expiresAt);
 desired=await desiredProjection(f.db,f.now());
 assert.equal(desired.length,1);
 data=input(await snapshot(f),['owner@example.test','person@example.test'],f.now());
 assert.equal(preflightAccessProjection(data).differences[0].kind,'extra-or-ineligible');
 await assert.rejects(f.repo.claim(invite.id,invite.secret,await f.identity()));
 assert.equal(await f.repo.authorize(await f.identity()),false);
 // A fresh fixture invitation can activate; revocation remains authoritative.
 await f.adapter.remove(id);
 const second=await f.pending('second@example.test'), ready=await f.ready(second);
 const secondIdentity=await f.identity('google','subject-two','second@example.test');
 await f.repo.claim(ready.id,ready.secret,secondIdentity);
 assert.equal(await f.repo.authorize(secondIdentity),true);
 await f.repo.revoke('owner',second);
 data=input(await snapshot(f),['owner@example.test','second@example.test'],f.now());
 const result=preflightAccessProjection(data);
 assert.equal(result.reconciliation,'DRIFT');
 assert.equal(await f.repo.authorize(secondIdentity),false);
 assert.equal(result.status,'BLOCKED');
 assert.equal(await f.repo.authorize(identity),false);
});

for(const provider of ['google','otp']) test(`OFFLINE PROXY ${provider==='google'?'P1':'P2'} preflight: manual Access contact cannot create or authorize D1 member`,async t=>{
 const f=await fixture(t), before=await snapshot(f);
 const result=preflightAccessProjection(input(before,['owner@example.test','uninvited@example.test']));
 assert.equal(result.differences[0].kind,'extra-or-ineligible');
 assert.equal(await f.repo.authorize(await f.identity(provider,'uninvited-subject','uninvited@example.test')),false);
 assert.deepEqual(await snapshot(f),before);
 assert.equal(result.status,'BLOCKED');
});
