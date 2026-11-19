import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductionMemberWorker,productionBindingsReady} from './production-otp-release-entry.mjs';
import {approvedMemberOriginReady} from '../portal/member-dashboard.mjs';

const ORIGIN='https://members.bigsoxstudios.com';
const DB_ID='01234567-89ab-4cde-8f01-23456789abcd'; // synthetic; no live D1 created
const fakeD1=()=>({prepare(){throw Error('No DB access expected');},batch(){throw Error('No DB writes expected');}});
function env(overrides={}) {
 return {
  APP_ORIGIN:ORIGIN,
  ACCESS_ISSUER:'https://old-hill-995d.cloudflareaccess.com',
  ACCESS_AUDIENCE:'a'.repeat(64),
  OWNER_ACCESS_AUDIENCE:'e558d6d6d467575e87242a666242f508dc6355e5d0f14f07bb9fa0a808e5b7c0',
  APPROVED_REQUESTS_ID:'21e13fa1-0ab3-4573-8d20-983c847ba0e9',
  APPROVED_MEMBER_DB_ID:DB_ID,BOOTSTRAP_DATABASE_ID:DB_ID,
  OTP_CUSTOM_HOSTS:['members.bigsoxstudios.com'],
  PORTAL_PRODUCTION_MODE:'reviewed-production-12',
  PORTAL_APPROVED_OTP_ASSEMBLY:'reviewed-production-12',
  PORTAL_APPROVED_MEMBERS:'enabled-12-approved',
  PORTAL_SIMPLIFIED_MEMBER_UI:'enabled-12',
  DB:fakeD1(),APPROVED_REQUESTS_DB:fakeD1(),...overrides
 };
}
const worker=createProductionMemberWorker();
const get=(path,options={},e=env())=>worker.fetch(new Request(ORIGIN+path,options),e,{});

test('production configuration must be reviewed, isolated and exact',()=>{
 assert.equal(productionBindingsReady(env()),true);
 assert.equal(approvedMemberOriginReady(env()),true);
 for(const altered of [
  {PORTAL_PRODUCTION_MODE:'disabled-before-verified-release'},
  {APP_ORIGIN:'https://members-staging.bigsoxstudios.com'},
  {APPROVED_REQUESTS_ID:'48b0a0cc-40ad-4495-8883-a42b4a938b71'},
  {APPROVED_MEMBER_DB_ID:'43a8a15b-e195-4712-9198-1dcc9f0152af'},
  {APPROVED_MEMBER_DB_ID:'21e13fa1-0ab3-4573-8d20-983c847ba0e9'},
  {BOOTSTRAP_DATABASE_ID:'11111111-1111-4111-8111-111111111111'},
  {ACCESS_AUDIENCE:'f3ad2eeca58fc7e607b96e47b28672b78a920d34474f97a15e56a6235fc1cdbe'},
  {ACCESS_AUDIENCE:'e558d6d6d467575e87242a666242f508dc6355e5d0f14f07bb9fa0a808e5b7c0'},
  {OTP_CUSTOM_HOSTS:['members-staging.bigsoxstudios.com']},
  {PORTAL_APPROVED_OTP_ASSEMBLY:'reviewed-staging-12'},
  {DB:undefined}, {APPROVED_REQUESTS_DB:undefined},
 ]) assert.equal(productionBindingsReady(env(altered)),false,JSON.stringify(altered));
 const shared=fakeD1();
 assert.equal(productionBindingsReady(env({DB:shared,APPROVED_REQUESTS_DB:shared})),false);
});

test('staging admission pins preserved; production needs production flag',()=>{
 assert.equal(approvedMemberOriginReady({
  APPROVED_REQUESTS_DB:fakeD1(),
  APP_ORIGIN:'https://members-staging.bigsoxstudios.com',
  APPROVED_REQUESTS_ID:'48b0a0cc-40ad-4495-8883-a42b4a938b71',
  APPROVED_MEMBER_DB_ID:'43a8a15b-e195-4712-9198-1dcc9f0152af'
 }),true);
 assert.equal(approvedMemberOriginReady(env({PORTAL_PRODUCTION_MODE:'disabled-before-verified-release'})),false);
 assert.equal(approvedMemberOriginReady(env({APPROVED_MEMBER_DB_ID:'43a8a15b-e195-4712-9198-1dcc9f0152af'})),false);
});

test('production Worker rejects wrong origin, host, URL and unknown path',async()=>{
 assert.equal((await worker.fetch(new Request('https://members-staging.bigsoxstudios.com/app'),env(),{})).status,404);
 assert.equal((await worker.fetch(new Request(ORIGIN+'/app',{headers:{Host:'evil.example'}}),env(),{})).status,404);
 assert.equal((await get('/unknown')).status,404);
 assert.equal((await worker.fetch(new Request('http://members.bigsoxstudios.com/app'),env(),{})).status,404);
});

test('unreviewed or incomplete production configuration always fails closed',async()=>{
 for(const bad of [{PORTAL_PRODUCTION_MODE:'disabled-before-verified-release'},
   {ACCESS_AUDIENCE:'REPLACE_WITH_ACCESS'},
   {APPROVED_MEMBER_DB_ID:'REPLACE_WITH_DATABASE'}]){
  const result=await get('/app',{},env(bad));
  assert.equal(result.status,503);
  assert.equal(await result.text(),'Members Portal setup unavailable');
 }
});

test('approved-looking deployment still requires a signed OTP and verified Access context',async()=>{
 const r=await get('/app');
 assert.equal(r.status,403);
 assert.match(await r.text(),/Access unavailable/);
 const post=await get('/app',{method:'POST'});
 assert.equal(post.status,403);
});

test('only valid reviewed origin may redirect to protected /app',async()=>{
 const r=await get('/');
 assert.equal(r.status,303);
 assert.equal(r.headers.get('Location'),'/app');
 assert.equal((await get('/',{},env({PORTAL_PRODUCTION_MODE:'disabled'}))).status,503);
 assert.equal((await get('/',{method:'POST'})).status,405);
});

test('Wrangler examples remain unroutable and cannot accidentally activate',async()=>{
 const {readFileSync}=await import('node:fs');
 const member=readFileSync(new URL('./wrangler.production.example.toml',import.meta.url),'utf8');
 const owner=readFileSync(new URL('../owner-launchpad/wrangler.task12.production.example.toml',import.meta.url),'utf8');
 assert.match(member,/workers_dev = false/);
 assert.match(member,/preview_urls = false/);
 assert.doesNotMatch(member,/^\s*routes?\s*=/m);
 assert.match(member,/PORTAL_PRODUCTION_MODE = "disabled-before-verified-release"/);
 assert.match(member,/REPLACE_WITH_NEW_PRODUCTION_MEMBERS_D1_UUID/);
 assert.match(member,/REPLACE_WITH_NEW_MEMBERS_PRODUCTION_ACCESS_AUDIENCE/);
 assert.doesNotMatch(member,/43a8a15b-e195-4712-9198-1dcc9f0152af/);
 assert.doesNotMatch(member,/48b0a0cc-40ad-4495-8883-a42b4a938b71/);
 assert.match(owner,/workers_dev = false/);
 assert.match(owner,/preview_urls = false/);
 assert.doesNotMatch(owner,/^\s*routes?\s*=/m);
 assert.match(owner,/PORTAL_WELCOME_LIVE_SEND = "disabled-reconciliation-12"/);
 assert.match(owner,/REPLACE_WITH_NEW_PRODUCTION_MEMBERS_D1_UUID/);
 assert.doesNotMatch(owner,/43a8a15b-e195-4712-9198-1dcc9f0152af/);
});
