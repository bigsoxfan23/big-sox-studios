import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,epoch,envConfig,token,request,certFetch,identityClaims,resolver} from './test-support.mjs';
import {createAuthenticator} from './access.mjs';
import {createIdentityAuthenticator} from './identity.mjs';

for(const provider of ['google','otp','apple']) test(`OFFLINE: ${provider} first claim requires distinct verified provider+subject and invite`,async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.ready(id), identity=await f.identity(provider,'stable-'+provider);
 assert.equal(await f.repo.lookup(identity),null);
 await f.repo.claim(invite.id,invite.secret,identity);
 assert.equal((await f.repo.lookup(identity)).id,id);
 assert.equal(await f.repo.lookup(await f.identity(provider,'another-subject')),null);
 const alternate=provider==='google'?'otp':'google';
 assert.equal(await f.repo.lookup(await f.identity(alternate,'stable-'+provider)),null);
});
for(const provider of ['google','otp']) test(`OFFLINE PROXY ${provider==='google'?'P1':'P2'}: uninvited ${provider} creates no rows`,async t=>{
 const f=await fixture(t), identity=await f.identity(provider);
 assert.equal(await f.repo.authorize(identity),false);
 await assert.rejects(f.repo.claim('unknown','a'.repeat(43),identity));
 assert.equal((await f.db.prepare('SELECT count(*) n FROM members').first()).n,1);
 assert.equal((await f.db.prepare('SELECT count(*) n FROM identities').first()).n,0);
 assert.equal((await f.db.prepare('SELECT count(*) n FROM invitations').first()).n,0);
});
test('OFFLINE: Apple private relay mismatch denies; matching email never auto-links',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.ready(id);
 await assert.rejects(f.repo.claim(invite.id,invite.secret,await f.identity('apple','apple-sub','relay@privaterelay.example.test')));
 await f.repo.claim(invite.id,invite.secret,await f.identity());
 assert.equal(await f.repo.authorize(await f.identity('apple','apple-sub')),false);
});
test('OFFLINE: manual link requires bound current identity, separate candidate verification and owner approval',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.ready(id), current=await f.identity(), candidate=await f.identity('apple','apple-sub','relay@privaterelay.example.test');
 await f.repo.claim(invite.id,invite.secret,current);
 await assert.rejects(f.repo.requestLink(candidate,current));
 await assert.rejects(f.repo.requestLink(current,{provider:'apple',subject:'fake'}));
 const link=await f.repo.requestLink(current,candidate);
 await assert.rejects(f.repo.commitLink('owner',link));
 await assert.rejects(f.repo.approveLink(id,link));
 await f.repo.approveLink('owner',link);
 assert.equal(await f.repo.authorize(candidate),false);
 await f.repo.commitLink('owner',link);
 assert.equal((await f.repo.lookup(candidate)).id,id);
 await assert.rejects(f.repo.commitLink('owner',link));
});
test('OFFLINE: link collision is atomic and expired/revoked links deny',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.ready(id), current=await f.identity();
 await f.repo.claim(invite.id,invite.secret,current);
 const other=await f.pending('other@example.test'), second=await f.ready(other), candidate=await f.identity('otp','other-sub','other@example.test');
 await f.repo.claim(second.id,second.secret,candidate);
 const link=await f.repo.requestLink(current,candidate); await f.repo.approveLink('owner',link);
 await assert.rejects(f.repo.commitLink('owner',link));
 assert.equal((await f.db.prepare('SELECT status FROM link_requests WHERE id=?').bind(link).first()).status,'approved');
 assert.equal((await f.repo.lookup(candidate)).id,other);
 const expiry=await f.repo.requestLink(current,await f.identity('apple','new-sub'));
 f.time(epoch+900); await assert.rejects(f.repo.approveLink('owner',expiry));
 const rev=await f.repo.requestLink(current,await f.identity('apple','fresh-sub'));
 await f.repo.approveLink('owner',rev); await f.repo.revoke('owner',id);
 await assert.rejects(f.repo.commitLink('owner',rev));
});
test('OFFLINE: absent provider mapping, unsigned browser proof and unverified provider claims fail closed',async()=>{
 const authenticate=createAuthenticator({fetcher:certFetch,now:()=>epoch*1000});
 await assert.rejects(createIdentityAuthenticator({authenticate})(request(token()),envConfig));
 const verify=createIdentityAuthenticator({authenticate,resolveVerifiedIdentity:resolver});
 await assert.rejects(verify(request(token()),envConfig)); // ordinary Access sub/email cannot bind
 for(const changes of [{emailVerified:false},{stableSubjectVerified:false},{mfaVerified:false},{provider:'untrusted'},{subject:''},{accessSubject:'different'}]) {
  // Resolver deliberately overwrites accessSubject with signed claims.sub; test
  // session mismatch separately with an intentionally bad resolver below.
  if(changes.accessSubject) continue;
  await assert.rejects(verify(request(token(identityClaims('google','sub','person@example.test',changes))),envConfig));
 }
 const mismatch=createIdentityAuthenticator({authenticate,resolveVerifiedIdentity:async claims=>({...await resolver(claims),accessSubject:'different-session'})});
 await assert.rejects(mismatch(request(token(identityClaims())),envConfig));
});
