// Source only; no route, login, credentials or access-policy implementation.
// The future reviewed authenticated Owner route must explicitly confirm review
// and HMAC-sign welcomeReconciliationProofValue using the existing server key
// and authenticated session binding. This module deliberately cannot mint proof.
// The original intent's still-active Owner alone may record evidence. Historical
// Member status does not grant access and does not prevent receipt investigation.
const fail = () => { throw Error('Welcome reconciliation unavailable. Original intent remains locked.'); };
const id = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const safeTime = t => Number.isSafeInteger(t) && t >= 0;
const states = ['dispatching','UNKNOWN','accepted'];
const statuses = ['sent','delivered','delivery_delayed','bounced','complained','failed'];
const bytes = s => new TextEncoder().encode(s);
const hex = b => [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const flags = Object.freeze({activationAuthorized:false,mayRetry:false,delivered:false});
const evidenceKeys = ['intentId','intentState','providerId','providerStatus','observedAt'];
function checkEvidence(e) {
 if (!e || Object.getPrototypeOf(e) !== Object.prototype || Object.keys(e).length !== evidenceKeys.length
  || evidenceKeys.some(k=>!Object.hasOwn(e,k)) || !uuid(e.intentId) || !states.includes(e.intentState)
  || !uuid(e.providerId) || !statuses.includes(e.providerStatus) || !safeTime(e.observedAt)) fail();
}
// Canonical signing contract only. No signing capability or route authorization.
export function welcomeReconciliationProofValue({actorId,sourceDatabase,sessionBinding,evidence,issuedAt,expiresAt,nonce}={}) {
 checkEvidence(evidence);
 if (!id(actorId) || !id(sourceDatabase) || typeof sessionBinding !== 'string' || sessionBinding.length < 32 || sessionBinding.length > 512
  || !safeTime(issuedAt) || !safeTime(expiresAt) || issuedAt < evidence.observedAt
  || expiresAt <= issuedAt || expiresAt > issuedAt+300 || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) fail();
 return JSON.stringify(['bss-welcome-reconciliation-v1',actorId,sourceDatabase,sessionBinding,
  evidence.intentId,evidence.intentState,evidence.providerId,evidence.providerStatus,evidence.observedAt,issuedAt,expiresAt,nonce]);
}

export function createWelcomeReconciliation({enabled=false,memberDb,adapter,sourceDatabase,actorId,
 sessionBinding,signingKey,expiresAt,now=()=>Math.floor(Date.now()/1000)}={}) {
 if (enabled !== true) return Object.freeze({verifyReceipt:async()=>fail(),recordEvidence:async()=>fail()});
 if (!memberDb?.prepare || typeof adapter?.inspect !== 'function' || !id(sourceDatabase) || !id(actorId)
  || typeof sessionBinding !== 'string' || sessionBinding.length < 32 || sessionBinding.length > 512
  || typeof signingKey !== 'string' || bytes(signingKey).length < 32 || !safeTime(expiresAt) || typeof now !== 'function') fail();
 const q = (sql,...args) => memberDb.prepare(sql).bind(...args);
 const time = () => { const at=now(); if (!safeTime(at) || at >= expiresAt) fail(); return at; };
 async function intent(intentId) {
  time(); if (!uuid(intentId)) fail();
  const row=await q(`SELECT i.id,i.state,i.provider_id,i.recipient,i.updated_at FROM welcome_intents i
   WHERE i.id=? AND i.source_database=? AND i.actor_id=? AND i.mode='live' AND i.state IN ('dispatching','UNKNOWN','accepted')
   AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active')
   AND unixepoch('now')<?`,intentId,sourceDatabase,actorId,actorId,expiresAt).first();
  time(); if (!row) fail(); return row;
 }
 async function inspect(row, providerId) {
  if (!uuid(providerId) || (row.state === 'accepted' && row.provider_id !== providerId)) fail();
  let result; try { result=await adapter.inspect({providerId,recipient:row.recipient}); } catch { result=null; }
  const at=time();
  if (!result || result.state !== 'provider-observed' || result.providerId !== providerId || !statuses.includes(result.providerStatus)) return null;
  // Re-read authorization/state after asynchronous readback. An incomplete or
  // mismatched response is uncertainty, never evidence of failure or permission.
  const fresh=await intent(row.id);
  if (fresh.state !== row.state || fresh.updated_at !== row.updated_at || at < row.updated_at) fail();
  return {intentId:row.id,intentState:row.state,providerId,providerStatus:result.providerStatus,observedAt:time()};
 }
 return Object.freeze({
  async verifyReceipt(intentId, providerId) {
   try {
    const row=await intent(intentId), evidence=await inspect(row,providerId ?? row.provider_id);
    return evidence ? Object.freeze({state:'provider-observed',evidence:Object.freeze(evidence),...flags})
     : Object.freeze({state:'UNKNOWN',...flags});
   } catch { fail(); }
  },
  async recordEvidence(evidence, proof) {
   try {
    checkEvidence(evidence);
    // Snapshot caller input before any await. Extra fields (including body,
    // passwords and free-form notes) are refused rather than persisted.
    evidence={...evidence};
    if (!proof || Object.getPrototypeOf(proof) !== Object.prototype || Object.keys(proof).length !== 5
     || proof.confirmed !== true || typeof proof.signature !== 'string' || !/^[a-f0-9]{64}$/.test(proof.signature)) fail();
    proof={...proof};
    const {issuedAt,expiresAt:until,nonce,signature}=proof, at=time();
    const value=welcomeReconciliationProofValue({actorId,sourceDatabase,sessionBinding,evidence,issuedAt,expiresAt:until,nonce});
    if (at < issuedAt || at >= until || until > expiresAt || at-evidence.observedAt > 300) fail();
    const key=await crypto.subtle.importKey('raw',bytes(signingKey),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    if (!await crypto.subtle.verify('HMAC',key,Uint8Array.from(signature.match(/../g),x=>parseInt(x,16)),bytes(value))) fail();
    const row=await intent(evidence.intentId);
    if (row.state !== evidence.intentState || evidence.observedAt < row.updated_at) fail();
    // A signature alone cannot fabricate a provider observation: corroborate
    // again via inspect only, and refuse if the signed status has changed.
    const readback=await inspect(row,evidence.providerId);
    if (!readback || readback.providerStatus !== evidence.providerStatus) fail();
    const digest=hex(await crypto.subtle.digest('SHA-256',bytes(value+'.'+signature))), recordedAt=time();
    if (recordedAt < issuedAt || recordedAt >= until || recordedAt-evidence.observedAt > 300) fail();
    const eventId=crypto.randomUUID();
    const event=await q(`INSERT INTO welcome_reconciliation_events
     (id,intent_id,actor_id,intent_state,provider_id,provider_status,observed_at,recorded_at,review_issued_at,review_expires_at,proof_digest)
     VALUES(?,(SELECT i.id FROM welcome_intents i WHERE i.id=? AND i.source_database=? AND i.actor_id=?
      AND i.mode='live' AND i.state=? AND i.updated_at<=?
      AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active')
      AND unixepoch('now')>=? AND unixepoch('now')<?),?,?,?,?,?,?,?,?,?) RETURNING id`,
     eventId,evidence.intentId,sourceDatabase,actorId,evidence.intentState,evidence.observedAt,actorId,issuedAt,Math.min(expiresAt,until),
     actorId,evidence.intentState,evidence.providerId,evidence.providerStatus,evidence.observedAt,recordedAt,issuedAt,until,digest).first();
    if (event?.id !== eventId) fail();
    return Object.freeze({id:eventId,intentId:evidence.intentId,state:'evidence-recorded',...flags});
   } catch { fail(); }
  }
 });
}
