import {createAuthenticator,validateConfig,b64} from './access.mjs';
import {createIdentityAuthenticator,normalizeEmail} from './identity.mjs';

const check = value => { if (!value) throw Error('denied'); };
const bounded = (value,max=512) => typeof value==='string' && value.length>0 && value.length<=max && [...value].every(c=>c.charCodeAt(0)>32 && c.charCodeAt(0)!==127);
const object = value => value!==null && typeof value==='object' && !Array.isArray(value);
export const tokenDigest = async token => b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));

// Transport is real; subject/MFA interpretation deliberately has NO live mapping.
// Only offline tests may inject a verifier. Never interpret idp.id, user_uuid,
// email, JWT sub or an arbitrary `subject`/`amr` field as upstream authority.
export function createOwnerProof({mode,fetcher=fetch,now=()=>Date.now(),verifyUpstreamEvidence}={}) {
 const authenticate=createAuthenticator({fetcher,now});
 const used=new Map(); // OFFLINE replay model, not distributed production state.
 const identity=createIdentityAuthenticator({authenticate,resolveVerifiedIdentity:async(claims,request,env)=>{
  check(mode==='offline-test');
  check(claims.type==='app' && !['common_name','service_token_id'].some(k=>k in claims));
  check(bounded(claims.identity_nonce) && bounded(env.OWNER_ACCOUNT_ID) && bounded(env.OWNER_CONNECTION_ID));
  const seconds=Math.floor(now()/1000);
  check(seconds-claims.iat<=300);
  const email=normalizeEmail(claims.email);
  const cookie=request.headers.get('Cookie');
  check(typeof cookie==='string' && cookie.length<=32768);
  const matches=cookie.split(';').map(x=>x.trim()).filter(x=>x.split('=',1)[0]==='CF_Authorization');
  check(matches.length===1);
  const jwt=matches[0].slice('CF_Authorization='.length);
  check(jwt===request.headers.get('Cf-Access-Jwt-Assertion'));
  const controller=new AbortController(); let timer;
  let data;
  try {
   const work=async()=>{
    const response=await fetcher(`${env.ACCESS_ISSUER}/cdn-cgi/access/get-identity`,{
     method:'GET',headers:{Cookie:`CF_Authorization=${jwt}`,Accept:'application/json'},
     redirect:'manual',cache:'no-store',signal:controller.signal
    });
    check(response.status===200 && !response.redirected && response.headers.get('Content-Type')?.split(';')[0].trim()==='application/json');
    const reader=response.body?.getReader(); check(reader);
    let length=0; const chunks=[];
    try {
     while(true) {
      const {value,done}=await reader.read(); if(done) break;
      length+=value.length; check(length<=32768); chunks.push(value);
     }
    } finally { await reader.cancel().catch(()=>{}); }
    const bytes=new Uint8Array(length); let offset=0;
    for(const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   };
   data=await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('denied'));},3000);})]);
  } finally {clearTimeout(timer);controller.abort();}
  // Conservative candidate correlation, NOT a documented upstream proof schema.
  // identity_nonce echo and user_uuid/sub equivalence still need live provenance.
  check(object(data) && data.account_id===env.OWNER_ACCOUNT_ID && data.user_uuid===claims.sub &&
   data.identity_nonce===claims.identity_nonce && data.email===email && data.iat===claims.iat &&
   !data.service_token_id && !data.service_token_status);
  check(typeof verifyUpstreamEvidence==='function');
  const digest=await tokenDigest(jwt);
  // Trusted verifier must independently authenticate signature/provenance,
  // Google connection, subject, verified email and independent MFA for THIS
  // session. Test fixtures below are not a Cloudflare contract or real verifier.
  const proof=await verifyUpstreamEvidence({claims,data,tokenDigest:digest});
  const at=Math.floor(now()/1000);
  check(object(proof) && proof.provider==='google' && bounded(proof.subject) && proof.subject!==claims.sub && proof.subject!==email && proof.connection===env.OWNER_CONNECTION_ID &&
   proof.accountId===env.OWNER_ACCOUNT_ID && proof.accessSubject===claims.sub &&
   proof.sessionNonce===claims.identity_nonce && proof.tokenDigest===digest &&
   proof.email===email && proof.emailVerified===true && proof.stableSubjectVerified===true &&
   proof.independentMfaVerified===true && proof.mfaVerified===true &&
   Array.isArray(proof.amr) && proof.amr.length<=16 && proof.amr.every(x=>bounded(x,64)) && proof.amr.includes('mfa') &&
   bounded(proof.proofId,128) && Number.isSafeInteger(proof.issuedAt) && proof.issuedAt<=at && at-proof.issuedAt<=60 &&
   Number.isSafeInteger(proof.expiresAt) && proof.expiresAt>at && proof.expiresAt<=at+60 && proof.expiresAt<=claims.exp);
  // Consume before the next await; never evict an unexpired proof to make space.
  for(const [id,expiry] of used) if(expiry<=at) used.delete(id);
  check(!used.has(proof.proofId) && used.size<128);
  used.set(proof.proofId,proof.expiresAt);
  return proof;
 }});
 return async(request,env)=>{
  try {validateConfig(env);check(mode==='offline-test');return await identity(request,env);}
  catch {throw Error('denied');}
 };
}
