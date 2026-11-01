// Coordinates an ephemeral confirmed payload with durable secret-free metadata.
// No network transport is enabled by this release. Owner routes may exercise
// simulation only; simulated acceptance NEVER authorizes membership activation.
const fail=()=>{throw Error('Welcome delivery unavailable. Check its recorded status before retrying.');};
const identifier=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s);
const safeTime=t=>Number.isSafeInteger(t)&&t>=0;
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
// Trusted server-side test adapter, never chosen from client form fields.
export function simulatedWelcomeProvider({outcome='accepted',wait=Promise.resolve()}={}) {
 if(!['accepted','failed','UNKNOWN','throw'].includes(outcome))fail();
 return async({intentId})=>{await wait;if(outcome==='throw')throw Error('synthetic transport failure');return outcome==='accepted'?{state:'accepted',providerId:'mock-'+intentId}:{state:outcome};};
}
export function createWelcomeDelivery({memberDb,onboarding,review,sourceDatabase,actorId,expiresAt,mode='simulated',provider=simulatedWelcomeProvider(),timeoutMs=8000,now=()=>Math.floor(Date.now()/1000)}={}) {
 if(!memberDb?.prepare||typeof onboarding?.read!=='function'||typeof review?.confirm!=='function'||!identifier(sourceDatabase)||!identifier(actorId)
  ||!safeTime(expiresAt)||mode!=='simulated'||typeof provider!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>8000)fail();
 const q=(sql,...args)=>memberDb.prepare(sql).bind(...args);
 const time=()=>{const t=now();if(!safeTime(t)||t>=expiresAt)fail();return t;};
 async function current(requestId,revision,mail) {
  if(!safeTime(mail.reviewExpiresAt)||time()>=mail.reviewExpiresAt)fail();
  const row=await onboarding.read(requestId,revision);if(time()>=mail.reviewExpiresAt)fail();
  if(row.source_database!==sourceDatabase||row.member_id!==mail.memberId||row.revision!==mail.onboardingRevision||row.recipient!==mail.recipient
   ||row.role!=='member'||row.status!=='pending'||row.jellyfin_ready_at===null)fail();return row;
 }
 return Object.freeze({
  async status(requestId,requestRevision) {
   await onboarding.read(requestId,requestRevision);time();
   return (await q('SELECT id,mode,state,created_at,updated_at FROM welcome_intents WHERE source_database=? AND request_id=? ORDER BY rowid DESC',sourceDatabase,requestId).all()).results;
  },
  async send(requestId,requestRevision,form,confirmation) {
   // All content validation/proof verification happens before durable claim.
   const mail=await review.confirm(requestId,requestRevision,form,confirmation),row=await current(requestId,requestRevision,mail);
   const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(confirmation.review)))].map(x=>x.toString(16).padStart(2,'0')).join('');
   const id=crypto.randomUUID(),at=time(),deadline=Math.min(expiresAt,mail.reviewExpiresAt);if(at>=deadline)fail();
   // Mandatory member_id subquery turns a session/CAS failure into a constraint
   // failure. A unique partial index excludes duplicate/uncertain prior sends.
   const intent=await q(`INSERT INTO welcome_intents(id,source_database,request_id,member_id,actor_id,onboarding_revision,recipient,confirmation_digest,mode,state,created_at,updated_at)
    VALUES(?,?,?,(SELECT m.id FROM members m JOIN member_onboarding o ON o.member_id=m.id
    WHERE o.source_database=? AND o.request_id=? AND o.revision=? AND o.jellyfin_ready_at IS NOT NULL
    AND m.id=? AND m.recipient=? AND m.status='pending' AND m.role='member'
    AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active') AND unixepoch('now')<?),?,?,?,?,'simulated','dispatching',?,?) RETURNING id`,
    id,sourceDatabase,requestId,sourceDatabase,requestId,row.revision,row.member_id,mail.recipient,actorId,deadline,actorId,row.revision,mail.recipient,digest,at,at).first();
   if(!intent)fail();
   let outcome={state:'UNKNOWN'};
   try {
    // Cross-DB approval may have changed since the atomic Member DB claim.
    // No remote call starts if fresh eligibility fails. Never persist the body.
    try {await current(requestId,requestRevision,mail);if(time()>=mail.reviewExpiresAt)fail();}catch {outcome={state:'failed'};return await finish(id,outcome);}
    let timer;try {outcome=await Promise.race([provider({intentId:id,recipient:mail.recipient,subject:mail.subject,text:mail.text}),new Promise(resolve=>{timer=setTimeout(()=>resolve({state:'UNKNOWN'}),timeoutMs);})]);}catch {outcome={state:'UNKNOWN'};}finally{clearTimeout(timer);}
    if(!outcome||!['accepted','failed','UNKNOWN'].includes(outcome.state)||
     (outcome.state==='accepted'&&outcome.providerId!=='mock-'+id))outcome={state:'UNKNOWN'};
    return await finish(id,outcome);
   }catch { // A lost completion write leaves dispatching/UNKNOWN locked forever,
    // rather than allowing another send after a provider might have accepted.
    throw Error('Welcome outcome needs reconciliation. Do not resend.');
   }
  }
 });
 async function finish(id,result) {
  const at=now();if(!safeTime(at))fail();
  const row=await q("UPDATE welcome_intents SET state=?,provider_id=?,updated_at=MAX(updated_at,?) WHERE id=? AND state='dispatching' RETURNING id,state,mode",result.state,result.state==='accepted'?result.providerId:null,at,id).first();
  if(!row||!uuid(row.id))fail();return Object.freeze({...row,activated:false,delivered:false});
 }
}
