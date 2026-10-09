import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeMember,mayManageMembers,resolveIdentity} from './authorization.mjs';

test('deny missing and inactive members',()=>{
 assert.equal(authorizeMember(null,'jellyfin'),false);
 assert.equal(authorizeMember({state:'pending',role:'owner'},'jellyfin'),false);
 assert.equal(authorizeMember({state:'suspended',role:'owner'},'jellyfin'),false);
});
test('deny ungranted and unknown services',()=>{
 const member={state:'active',role:'member',grants:['status']};
 assert.equal(authorizeMember(member,'jellyfin'),false);
 assert.equal(authorizeMember(member,'status'),true);
 assert.equal(authorizeMember(member,'admin'),false);
});
test('only active owner can manage members',()=>{
 assert.equal(mayManageMembers({state:'active',role:'owner'}),true);
 assert.equal(mayManageMembers({state:'active',role:'trusted'}),false);
 assert.equal(mayManageMembers({state:'suspended',role:'owner'}),false);
});
test('provider identity never auto-links by email',()=>{
 const rows=[{provider:'google',subject:'google-123',member:{state:'active',role:'member'}}];
 assert.equal(resolveIdentity({provider:'apple',subject:'google-123',email:'same@example.com'},rows),null);
 assert.equal(resolveIdentity({provider:'google',subject:'google-123'},rows),rows[0].member);
});
