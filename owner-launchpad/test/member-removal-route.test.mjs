import test from 'node:test';
import assert from 'node:assert/strict';
import {welcomeFixture,seed} from './welcome-fixture.mjs';
async function fixture(){const f=await welcomeFixture();f.env.PORTAL_MEMBER_REMOVAL='enabled-12';const id=seed(f.storage,{status:'approved'}),path=`/membership/requests/${id}/setup`,page=await f.form(path);await f.post(path,page,{action:'start',request_revision:'1',confirm:'yes'});const member=f.portal.prepare("SELECT id FROM members WHERE role='member'").get().id;return{...f,member,path:`/membership/members/${member}/remove`};}
test('Owner removal requires confirmation, preserves history and shows manual Jellyfin reminder',async()=>{
 const f=await fixture(),page=await f.form(f.path);assert.equal(page.r.status,200);assert.match(page.html,/Website removal does not revoke Jellyfin/);
 const denied=await f.post(f.path,page,{member:f.member,confirm:'no'});assert.equal(denied.status,409);assert.equal(f.portal.prepare('SELECT count(*) n FROM revocations').get().n,0);
 const result=await f.post(f.path,page,{member:f.member,confirm:'yes'});assert.equal(result.status,200);assert.match(await result.text(),/Jellyfin account/);assert.equal(f.portal.prepare('SELECT status FROM members WHERE id=?').get(f.member).status,'revoked');
 assert.equal((await f.post(f.path,page,{member:f.member,confirm:'yes'})).status,409);assert.equal(f.portal.prepare('SELECT count(*) n FROM revocations').get().n,1);assert.equal(f.portal.prepare('SELECT count(*) n FROM member_onboarding').get().n,1);
 const directory=await f.form('/membership/members/');assert.match(directory.html,/Removed/);assert.doesNotMatch(directory.html,/Remove Member|Manage setup/);
});
test('URL target, CSRF, Origin and Owner identity are enforced before removal',async()=>{
 for(const kind of ['target','csrf','origin','owner','self']){
  const f=await fixture(),page=await f.form(f.path),fields={member:f.member,confirm:'yes'},headers={};
  if(kind==='target')fields.member='other';if(kind==='csrf')page.csrf='wrong';if(kind==='origin')headers.Origin='https://evil.example.test';if(kind==='owner')headers['Cf-Access-Jwt-Assertion']=await f.token('other@example.test');if(kind==='self')fields.member='owner';
  assert.ok([401,403,409].includes((await f.post(f.path,page,fields,headers)).status),kind);assert.equal(f.portal.prepare('SELECT count(*) n FROM revocations').get().n,0);
 }
});
test('disabled flag and Owner target cannot generate removal authority',async()=>{
 const f=await fixture();f.env.PORTAL_MEMBER_REMOVAL='off';assert.equal((await f.request(f.path)).status,404);f.env.PORTAL_MEMBER_REMOVAL='enabled-12';assert.equal((await f.request('/membership/members/owner/remove')).status,409);assert.equal(f.portal.prepare('SELECT count(*) n FROM revocations').get().n,0);
});
test('HEAD and read-only directory do not generate removal nonces',async()=>{
 const f=await fixture(),before=f.portal.prepare('SELECT count(*) n FROM owner_action_nonces').get().n;
 assert.equal((await f.request(f.path,{method:'HEAD'})).status,200);await f.request('/membership/members/');assert.equal(f.portal.prepare('SELECT count(*) n FROM owner_action_nonces').get().n,before);
});
