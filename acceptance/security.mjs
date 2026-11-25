import {createAuthenticator as ownerAuthenticator} from '../owner-launchpad/src/security.mjs';
import {createAuthenticator,b64,unb64} from '../portal/access.mjs';
import {createOtpAuthenticator} from '../portal/otp-identity.mjs';
import {PINS,must,sha256} from './config.mjs';
const encoder=new TextEncoder();
export function boundary(request,role) {
 const url=new URL(request.url),host=role==='owner'?PINS.ownerHost:PINS.memberHost;
 must(url.origin===`https://${host}` && url.host===host && !url.username && !url.password && !url.hash && !url.href.includes('?') &&
  !url.pathname.includes('%') && (!request.headers.has('Host') || request.headers.get('Host')===host) &&
  (!request.headers.has('Origin') || request.headers.get('Origin')===url.origin) && ['GET','POST'].includes(request.method));
 if(request.method==='POST') must(request.headers.get('Origin')===url.origin && request.headers.get('Sec-Fetch-Site')==='same-origin');
 if(request.headers.has('Sec-Fetch-Site')) must(['same-origin','none'].includes(request.headers.get('Sec-Fetch-Site')));
 return url;
}
export function createSecurity({fetcher=fetch,now=()=>Date.now(),verifyAccessPolicy}={}) {
 const ownerVerify=ownerAuthenticator({fetcher,now});
 const memberVerify=createOtpAuthenticator({verifyAccess:createAuthenticator({fetcher,now}),now});
 return async (request,env,ctx,role)=>{
  const audience=role==='owner'?PINS.ownerAudience:PINS.memberAudience;
  const authEnv={ACCESS_ISSUER:PINS.issuer,ACCESS_AUDIENCE:audience,
   OWNER_ACCESS_AUDIENCE:PINS.ownerAudience,OWNER_EMAIL:PINS.owner,
   APP_ORIGIN:`https://${role==='owner'?PINS.ownerHost:PINS.memberHost}`,OTP_CUSTOM_HOSTS:[PINS.memberHost]};
  const session=role==='owner'?await ownerVerify(request,authEnv):await memberVerify(request,authEnv,ctx);
  // Decode only AFTER existing signature verification. Tighten Owner audience to exclusive.
  const claims=JSON.parse(new TextDecoder().decode(unb64(request.headers.get('Cf-Access-Jwt-Assertion').split('.')[1])));
  must(claims.aud===audience || (Array.isArray(claims.aud) && claims.aud.length===1 && claims.aud[0]===audience));
  must(typeof claims.sub==='string' && claims.sub.length>0 && ctx?.access?.aud===audience && typeof ctx.access.getIdentity==='function');
  const runtime=await ctx.access.getIdentity();
  const expected=role==='owner'?PINS.owner:PINS.tester;
  must(claims.email===expected && runtime?.email===expected && (role==='owner' || session.subject===expected));
  // Existing OTP runtime proves OTP, not independent MFA. A separately reviewed,
  // server-owned readback/session verifier must establish unchanged Access + MFA.
  // An environment flag or unverified amr/client header is never that verifier.
  must(typeof verifyAccessPolicy==='function');
  const proof=await verifyAccessPolicy({request,claims,runtime,role,runId:env.ACCEPTANCE_RUN_ID,bindings:{requests:env.ACCEPTANCE_REQUESTS,members:env.ACCEPTANCE_MEMBERS,requestsId:env.ACCEPTANCE_REQUESTS_ID,membersId:env.ACCEPTANCE_MEMBERS_ID}});
  must(proof?.mfaVerified===true && proof.policyVerified===true && proof.allowlistVerified===true && proof.bindingsVerified===true &&
   proof.requestsId===PINS.requestsId && proof.membersId===PINS.membersId && proof.ownerHost===PINS.ownerHost && proof.memberHost===PINS.memberHost && proof.subject===claims.sub &&
   proof.audience===audience && proof.runId===env.ACCEPTANCE_RUN_ID && Number.isSafeInteger(proof.expiresAt) &&
   proof.expiresAt<=session.expiresAt && proof.expiresAt>Math.floor(now()/1000));
  return {expiresAt:proof.expiresAt,digest:await sha256(expected),role};
 };
}
async function key(env) {
 const raw=unb64(env.ACCEPTANCE_CSRF_KEY); must(raw.length===32);
 return crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
export async function csrfToken(request,env,expiresAt,now) {
 const data=b64(encoder.encode(JSON.stringify([PINS.revision,env.ACCEPTANCE_RUN_ID,await sha256(request.headers.get('Cf-Access-Jwt-Assertion')),Math.min(expiresAt,Math.floor(now()/1000)+300),crypto.randomUUID()])));
 return `${data}.${b64(await crypto.subtle.sign('HMAC',await key(env),encoder.encode(data)))}`;
}
export async function formBody(request,env,session,now) {
 must(request.headers.get('Content-Type')==='application/x-www-form-urlencoded' && Number(request.headers.get('Content-Length')||0)<=4096);
 const reader=request.body?.getReader(); must(reader);
 let size=0; const chunks=[];
 try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;must(size<=4096);chunks.push(value);}} finally {await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const form=new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 must([...form.keys()].length===new Set(form.keys()).size);
 const token=form.get('csrf'),cookies=request.headers.get('Cookie')||'';
 must(typeof token==='string' && token.length<2048 && cookies.split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Host-task12=')).length===1 && cookies.split(';').some(x=>x.trim()===`__Host-task12=${token}`));
 const parts=token.split('.');must(parts.length===2);
 must(await crypto.subtle.verify('HMAC',await key(env),unb64(parts[1]),encoder.encode(parts[0])));
 const [revision,run,jwtDigest,expiry]=JSON.parse(new TextDecoder().decode(unb64(parts[0])));
 must(revision===PINS.revision && run===env.ACCEPTANCE_RUN_ID && jwtDigest===await sha256(request.headers.get('Cf-Access-Jwt-Assertion')) &&
  Number.isSafeInteger(expiry) && expiry>Math.floor(now()/1000) && expiry<=session.expiresAt && form.get('source_revision')===PINS.revision);
 return form;
}
export const fresh=(session,now)=>must(session.expiresAt>Math.floor(now()/1000));
