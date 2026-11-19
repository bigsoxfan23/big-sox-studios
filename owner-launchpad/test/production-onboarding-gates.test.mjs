import test from 'node:test';
import assert from 'node:assert/strict';
import {onboardingEnabled,withdrawalHoldRequired,onboardingApi,memberDirectoryUrl,memberWelcomeUrl} from '../src/onboarding-route.mjs';

const PROD='https://owner.bigsoxstudios.com';
const STAGE='https://bss-owner-launchpad-staging.fridman-greg.workers.dev';
const DB='01234567-89ab-4cde-8f01-23456789abcd'; // fixture UUID; never live
const production=(changes={})=>({
 APP_ORIGIN:PROD,
 PORTAL_ONBOARDING:'production-12',
 PORTAL_PRODUCTION_ONBOARDING:'reviewed-production-12',
 ONBOARDING_SOURCE_ID:'21e13fa1-0ab3-4573-8d20-983c847ba0e9',
 ONBOARDING_MEMBER_DB_ID:DB,
 PRODUCTION_MEMBER_DB_ID:DB,
 ...changes
});
test('production withdrawal ALWAYS needs durable hold, even after flag downgrade',()=>{
 assert.equal(withdrawalHoldRequired(production()),true);
 assert.equal(withdrawalHoldRequired(production({PORTAL_ONBOARDING:'disabled-before-verified-release'})),true);
 assert.equal(withdrawalHoldRequired({APP_ORIGIN:PROD}),true);
 assert.equal(withdrawalHoldRequired({APP_ORIGIN:STAGE}),true);
 assert.equal(withdrawalHoldRequired({APP_ORIGIN:'https://unrelated.example'}),false);
});
test('production onboarding fails closed on missing approval, wrong D1, staging ID',()=>{
 assert.equal(onboardingEnabled(production()),true);
 for(const mismatch of [
  {PORTAL_ONBOARDING:'disabled-before-verified-release'},
  {PORTAL_PRODUCTION_ONBOARDING:'disabled-before-verified-release'},
  {ONBOARDING_SOURCE_ID:'48b0a0cc-40ad-4495-8883-a42b4a938b71'},
  {ONBOARDING_MEMBER_DB_ID:'43a8a15b-e195-4712-9198-1dcc9f0152af'},
  {PRODUCTION_MEMBER_DB_ID:'11111111-1111-4111-8111-111111111111'},
  {ONBOARDING_MEMBER_DB_ID:'21e13fa1-0ab3-4573-8d20-983c847ba0e9'},
  {APP_ORIGIN:'https://owner-staging.example'}
 ]) assert.equal(onboardingEnabled(production(mismatch)),false,JSON.stringify(mismatch));
});
test('no production Members D1 blocks withdrawal hold API before any write',async()=>{
 await assert.rejects(onboardingApi(production(),Date.now()+60000,()=>Date.now()));
 assert.equal(withdrawalHoldRequired(production()),true);
});
test('staging enablement and revocation hold fail-closed semantics preserved',()=>{
 assert.equal(onboardingEnabled({APP_ORIGIN:STAGE,PORTAL_ONBOARDING:'staging-12'}),true);
 assert.equal(withdrawalHoldRequired({APP_ORIGIN:STAGE,PORTAL_ONBOARDING:'disabled'}),true);
 assert.equal(onboardingEnabled({APP_ORIGIN:STAGE,PORTAL_ONBOARDING:'production-12'}),false);
});

test('production preview/member directory never links staging while staging is preserved',()=>{
 assert.equal(memberDirectoryUrl(production()),'https://members.bigsoxstudios.com/app/manage');
 assert.equal(memberWelcomeUrl(production()),'https://members.bigsoxstudios.com/app');
 assert.equal(memberDirectoryUrl({APP_ORIGIN:STAGE}),'https://members-staging.bigsoxstudios.com/app/manage');
 assert.equal(memberWelcomeUrl({APP_ORIGIN:STAGE}),'https://members-staging.bigsoxstudios.com/app');
});
