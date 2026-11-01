// Source contribution: this Codex CLI session, 2026-11-01. No JWT or live services.
import test from 'node:test';
import assert from 'node:assert/strict';
import release from './approved-otp-release-entry.mjs';
import {approvedOtpConfig} from './approved-otp-assembly.mjs';
import staging from './worker.mjs';

const origin=approvedOtpConfig.APP_ORIGIN,host=new URL(origin).host;
const paths=['/app','/app/services/jellyfin','/app/invite'];
const unexpected=()=>assert.fail('denial must precede identity or database access');
const binding=()=>({prepare:unexpected,batch:unexpected});
const config=()=>({...approvedOtpConfig,OTP_CUSTOM_HOSTS:[host],DB:binding(),APPROVED_REQUESTS_DB:binding()});
const context={access:{aud:approvedOtpConfig.ACCESS_AUDIENCE,getIdentity:unexpected}};
const request=(path='/app',urlOrigin=origin,headers={})=>new Request(urlOrigin+path,{headers});
function privateResponse(response,status){
 assert.equal(response.status,status);
 assert.match(response.headers.get('Cache-Control'),/no-store/);
 assert.equal(response.headers.get('Set-Cookie'),null);
}

test('release default export requires every approved configuration gate',async()=>{
 assert.equal(typeof release.fetch,'function');
 const invalid=[undefined,{},...Object.keys(approvedOtpConfig).flatMap(key=>[
  {...config(),[key]:undefined},{...config(),[key]:'unapproved'}
 ]),...[
  {OTP_CUSTOM_HOSTS:host},{OTP_CUSTOM_HOSTS:JSON.stringify([host])},{OTP_CUSTOM_HOSTS:[]},
  {OTP_CUSTOM_HOSTS:[host,'preview.example.test']},{DB:undefined},{APPROVED_REQUESTS_DB:undefined}
 ].map(patch=>({...config(),...patch}))];
 const shared=binding();invalid.push({...config(),DB:shared,APPROVED_REQUESTS_DB:shared});
 for(const env of invalid){
  for(const path of paths)privateResponse(await release.fetch(request(path),env,context),503);
 }
 const head=await release.fetch(new Request(request(),{method:'HEAD'}),{},context);
 privateResponse(head,503);assert.equal(await head.text(),'');
 assert.match(head.headers.get('X-Robots-Tag'),/noindex/);
 // Complete config reaches authentication, where the deliberately absent JWT denies.
 // No signing-key transport, runtime identity read or D1 operation is needed.
 privateResponse(await release.fetch(request(),config(),context),403);
});

test('release entry cannot expose private app on spoofed, direct or preview hosts',async()=>{
 const targets=[
  ['https://preview.example.test',{}],
  ['https://big-sox-studios-members-staging.fridman-greg.workers.dev',{}],
  ['https://candidate.big-sox-studios-members-staging.fridman-greg.workers.dev',{Host:host}],
  ['https://bigsoxstudios.com',{}],
  ['http://'+host,{}],['https://'+host+':8443',{}],
  [origin,{Host:'preview.example.test'}],
  ['https://preview.example.test',{Host:host,'X-Forwarded-Host':host}],
 ];
 for(const env of [{},config()]){
  for(const [urlOrigin,headers] of targets){
   for(const path of paths)privateResponse(await release.fetch(request(path,urlOrigin,headers),env,context),404);
  }
 }
 privateResponse(await release.fetch(request('/app',origin,{Origin:'https://preview.example.test'}),config(),context),403);
});

test('existing default worker keeps private app disabled with every proposed flag and binding',async()=>{
 for(const env of [{},config()]){
  for(const path of paths)privateResponse(await staging.fetch(request(path),env,context),503);
 }
 privateResponse(await staging.fetch(request('/app','https://preview.example.test'),config(),context),404);
});
