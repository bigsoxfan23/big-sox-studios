import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerMembersLink,ownerMailDeskCard} from '../src/worker.mjs';

test('production Owner never points a non-onboarded Member action to staging',()=>{
 assert.equal(ownerMembersLink('https://owner.bigsoxstudios.com',false),'/membership/requests/');
 assert.equal(ownerMembersLink('https://owner.bigsoxstudios.com',true),'/membership/members/');
});
test('existing staging Member and local onboarding links are unchanged',()=>{
 assert.equal(ownerMembersLink('https://bss-owner-launchpad-staging.fridman-greg.workers.dev',false),'https://members-staging.bigsoxstudios.com/app/manage');
 assert.equal(ownerMembersLink('https://bss-owner-launchpad-staging.fridman-greg.workers.dev',true),'/membership/members/');
});

test('production correspondence card cannot navigate into staging Mail Desk',()=>{
 const result=ownerMailDeskCard('https://owner.bigsoxstudios.com','https://bss-mail-desk-staging.fridman-greg.workers.dev/');
 assert.doesNotMatch(result,/bss-mail-desk-staging|href=/);
 assert.match(result,/Not connected in production/);
 const staging=ownerMailDeskCard('https://bss-owner-launchpad-staging.fridman-greg.workers.dev','https://bss-mail-desk-staging.fridman-greg.workers.dev/');
 assert.match(staging,/href="https:\/\/bss-mail-desk-staging/);
});
