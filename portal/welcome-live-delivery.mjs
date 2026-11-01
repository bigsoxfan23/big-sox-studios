// Source only. A future reviewed authenticated Owner route must supply the
// existing review/onboarding APIs and reviewed transport. No credentials here.
// Message contents stay private and ephemeral; acceptance never grants access.
const fail = () => { throw Error('Welcome live delivery unavailable. Check recorded status before retrying.'); };
const id = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const safeTime = t => Number.isSafeInteger(t) && t >= 0;
const unknown = Object.freeze({state:'UNKNOWN'});

export function createWelcomeLiveDelivery({enabled=false, memberDb, onboarding, review, adapter,
 sourceDatabase, actorId, expiresAt, timeoutMs=8000, now=()=>Math.floor(Date.now()/1000)}={}) {
 if (enabled !== true) return Object.freeze({send:async()=>fail(), status:async()=>fail()});
 if (!memberDb?.prepare || typeof onboarding?.read !== 'function' || typeof review?.confirm !== 'function'
  || typeof adapter?.send !== 'function' || !id(sourceDatabase) || !id(actorId) || !safeTime(expiresAt)
  || typeof now !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) fail();
 const q = (sql,...args) => memberDb.prepare(sql).bind(...args);
 const time = deadline => { const t=now(); if (!safeTime(t) || t >= Math.min(expiresAt,deadline)) fail(); return t; };
 async function current(requestId, revision, mail) {
  time(mail.reviewExpiresAt);
  const row=await onboarding.read(requestId,revision);
  time(mail.reviewExpiresAt);
  if (!row || row.source_database !== sourceDatabase || row.member_id !== mail.memberId
   || row.revision !== mail.onboardingRevision || row.recipient !== mail.recipient
   || row.role !== 'member' || row.status !== 'pending' || !safeTime(row.jellyfin_ready_at) || row.jellyfin_ready_at === 0) fail();
  return row;
 }
 return Object.freeze({
  async status(requestId, requestRevision) {
   if (!id(requestId) || !Number.isSafeInteger(requestRevision) || requestRevision < 1) fail();
   time(expiresAt); await onboarding.read(requestId,requestRevision); time(expiresAt);
   const rows=await q(`SELECT id,mode,state,created_at,updated_at FROM welcome_intents
    WHERE source_database=? AND request_id=? AND mode='live'
    AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active')
    AND unixepoch('now')<? ORDER BY rowid DESC`,sourceDatabase,requestId,actorId,expiresAt).all();
   time(expiresAt); return rows.results;
  },
  async send(requestId, requestRevision, form, confirmation, {signal}={}) {
   try {
    if (!id(requestId) || !Number.isSafeInteger(requestRevision) || requestRevision < 1 || signal?.aborted) fail();
    // Verify the existing signed review over the exact ephemeral message.
    time(expiresAt);
    const mail=await review.confirm(requestId,requestRevision,form,confirmation);
    if (!safeTime(mail?.reviewExpiresAt) || !id(mail.memberId) || !Number.isSafeInteger(mail.onboardingRevision)
     || mail.onboardingRevision < 1 || typeof confirmation?.review !== 'string') fail();
    const row=await current(requestId,requestRevision,mail);
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(confirmation.review)))].map(x=>x.toString(16).padStart(2,'0')).join('');
    const intentId=crypto.randomUUID(), deadline=Math.min(expiresAt,mail.reviewExpiresAt), at=time(deadline);
    if (signal?.aborted) fail();
    // NOT NULL subquery + existing unique lock make authorization/deadline/CAS
    // failures atomic with the durable claim and its automatic audit event.
    const claimed=await q(`INSERT INTO welcome_intents
     (id,source_database,request_id,member_id,actor_id,onboarding_revision,recipient,confirmation_digest,mode,state,created_at,updated_at)
     VALUES(?,?,?,(SELECT m.id FROM members m JOIN member_onboarding o ON o.member_id=m.id
      WHERE o.source_database=? AND o.request_id=? AND o.revision=? AND o.jellyfin_ready_at IS NOT NULL
      AND m.id=? AND m.recipient=? AND m.role='member' AND m.status='pending'
      AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active')
      AND unixepoch('now')<?),?,?,?,?,'live','dispatching',?,?) RETURNING id`,
     intentId,sourceDatabase,requestId,sourceDatabase,requestId,row.revision,row.member_id,mail.recipient,
     actorId,deadline,actorId,row.revision,mail.recipient,digest,at,at).first();
    if (claimed?.id !== intentId) fail();
    let outcome=unknown;
    // Re-read cross-database approval and local eligibility at the dispatch
    // boundary. A known pre-dispatch refusal cannot have sent a message.
    try {
     await current(requestId,requestRevision,mail);
     const eligible=await q(`SELECT i.id FROM welcome_intents i
      JOIN members m ON m.id=i.member_id JOIN member_onboarding o ON o.member_id=m.id
      WHERE i.id=? AND i.mode='live' AND i.state='dispatching'
      AND o.source_database=i.source_database AND o.request_id=i.request_id AND o.revision=i.onboarding_revision
      AND o.jellyfin_ready_at IS NOT NULL AND m.role='member' AND m.status='pending' AND m.recipient=i.recipient
      AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active')
      AND unixepoch('now')<?`,intentId,actorId,deadline).first();
     time(deadline); if (!eligible) fail();
    } catch { return await finish(intentId,{state:signal?.aborted ? 'UNKNOWN' : 'failed'}); }
    if (!signal?.aborted) {
     let timer, onAbort;
     try {
      // Invoke only once. Abort/timeout is uncertainty, even if the adapter
      // eventually resolves. The reviewed adapter owns network cancellation.
      const stopped=new Promise(resolve=>{
       timer=setTimeout(()=>resolve(unknown),timeoutMs);
       onAbort=()=>resolve(unknown); signal?.addEventListener('abort',onAbort,{once:true});
      });
      outcome=await Promise.race([adapter.send({intentId,recipient:mail.recipient,subject:mail.subject,text:mail.text}),stopped]);
      if (signal?.aborted || !outcome || !['accepted','failed','UNKNOWN'].includes(outcome.state)
       || (outcome.state === 'accepted' && !uuid(outcome.providerId))) outcome=unknown;
     } catch { outcome=unknown; }
     finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort',onAbort); }
    }
    return await finish(intentId,outcome);
   } catch { fail(); } // Never return database/provider errors or message data.
  }
 });
 async function finish(intentId, outcome) {
  const at=now(); if (!safeTime(at)) fail();
  // No session deadline here: persist a late outcome rather than lose the
  // lock. A failed completion write leaves dispatching permanently locked.
  const row=await q(`UPDATE welcome_intents SET state=?,provider_id=?,updated_at=MAX(updated_at,?)
   WHERE id=? AND mode='live' AND state='dispatching' RETURNING id,state,mode`,
   outcome.state,outcome.state === 'accepted' ? outcome.providerId : null,at,intentId).first();
  if (row?.id !== intentId) fail();
  return Object.freeze({...row,activated:false,activationAuthorized:false,delivered:false,mayRetry:false});
 }
}
