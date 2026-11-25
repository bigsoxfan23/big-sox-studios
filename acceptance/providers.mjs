import {PINS,must} from './config.mjs';
// Provider preflight runs before any durable reservation or external I/O.
export async function verifiedProviders(providers,env,session,now,minUnsentQuota) {
 must(Number.isSafeInteger(minUnsentQuota) && (minUnsentQuota===1 || minUnsentQuota===2));
 // The Free/no-overage + >=2 SENDS snapshot is obtained ONCE before the run.
 // Subsequently enforce exact immutable TWO send attempts, not speculative
 // fresh Resend /usage (requires a prohibited full-access key).
 const runId=env?.ACCEPTANCE_RUN_ID;
 const [start,consumed]=await Promise.all([
  env.ACCEPTANCE_REQUESTS.prepare('SELECT * FROM acceptance_send_budget WHERE run_id=?').bind(runId).first(),
  env.ACCEPTANCE_REQUESTS.prepare(
   "SELECT COUNT(*) AS n FROM acceptance_effects WHERE kind IN ('owner_notice','test_welcome')"
  ).first(),
 ]);
 const at=Math.floor(now()/1000);
 must(start?.plan==='free' && start.overages_enabled===0 &&
  start.shared_quota_risk_accepted===1 && start.max_email_attempts===2 &&
  start.free_quota_at_start>=2 && Number.isSafeInteger(consumed?.n) &&
  consumed.n===(minUnsentQuota===2?0:1) &&
  (minUnsentQuota===1 || (start.quota_observed_at<=at && at-start.quota_observed_at<=300)) &&
  session.attestation?.preflight?.resend?.freeQuotaRemaining===start.free_quota_at_start);
 must(env.ACCEPTANCE_DISPATCH_GATE===`greg-one-run:${env.ACCEPTANCE_RUN_ID}` &&
  env.ACCEPTANCE_NOTION_PARENT===PINS.parent && env.ACCEPTANCE_OWNER_RECIPIENT===PINS.owner && env.ACCEPTANCE_TEST_RECIPIENT===PINS.tester &&
  typeof env.ACCEPTANCE_NOTION_CREDENTIAL==='string' && env.ACCEPTANCE_NOTION_CREDENTIAL.length>=32 &&
  typeof env.ACCEPTANCE_SENDER_CREDENTIAL==='string' && env.ACCEPTANCE_SENDER_CREDENTIAL.length>=32 &&
  env.ACCEPTANCE_NOTION_CREDENTIAL!==env.ACCEPTANCE_SENDER_CREDENTIAL &&
  typeof providers?.verifyScope==='function' && typeof providers?.createTicket==='function' &&
  typeof providers?.send==='function' && typeof providers?.verifyReceipt==='function');
 const proof=await providers.verifyScope({notionCredential:env.ACCEPTANCE_NOTION_CREDENTIAL,senderCredential:env.ACCEPTANCE_SENDER_CREDENTIAL,
  parent:PINS.parent,runId:env.ACCEPTANCE_RUN_ID,owner:PINS.owner,tester:PINS.tester,attestation:session.attestation});
 must(proof?.parent===PINS.parent && proof.runId===env.ACCEPTANCE_RUN_ID && proof.pageOnly===true && proof.privateParent===true &&
  proof.stagingOnly===true && proof.sendingOnly===true && proof.senderVerified===true && proof.zeroSpend===true &&
  proof.recipientPinsVerified===true && Number.isSafeInteger(proof.expiresAt) && proof.expiresAt>Math.floor(now()/1000) && session.expiresAt>Math.floor(now()/1000));
 return proof;
}
export function providerPayload(kind,request,id,recipient) {
 // Fixed allowlisted shape: never raw applicant text, headers, CC/BCC or reply-to.
 if(kind==='notion_ticket') return Object.freeze({parent:PINS.parent,title:'TEST · Task12 Acceptance — pending',runId:request.run_id,requestId:request.id,status:'pending',intentId:id});
 if(kind==='notion_decision') return Object.freeze({parent:PINS.parent,runId:request.run_id,requestId:request.id,
  intentId:id,pageId:request.page_id,decision:request.decision,decisionAt:request.decision_at,
  title:'TEST · Task12 Acceptance — '+request.decision+' · '+new Date(request.decision_at*1000).toISOString()});
 return Object.freeze({from:PINS.sender,to:kind==='owner_notice'?PINS.owner:PINS.tester,recipientDigest:recipient,
  subject:kind==='owner_notice'?'TEST request awaiting review':'TEST welcome — no service access',
  text:kind==='owner_notice'?`TEST request ${request.id}. Review https://${PINS.ownerHost}/acceptance/requests/`:
   `TEST welcome. No Jellyfin or other service access. https://${PINS.memberHost}/acceptance/app`,intentId:id});
}
export async function once(providers,kind,payload,credential,attestation) {
 // Timeout/crash can never free the durable reservation. Late results are ignored.
 const controller=new AbortController();let timer;
 try {
  const work=async()=>{
   const result=await (kind==='notion_ticket'?providers.createTicket(payload,{credential,attestation,signal:controller.signal}):
     kind==='notion_decision'?providers.updateTicket(payload,{credential,attestation,signal:controller.signal}):
     providers.send(payload,{credential,attestation,signal:controller.signal}));
   must(!controller.signal.aborted);
   if(result?.state==='refused') return {state:'refused',providerId:null};
   must(result?.state==='accepted' && typeof result.providerId==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(result.providerId));
   must(await providers.verifyReceipt({kind,payload,result,signal:controller.signal})===true && !controller.signal.aborted);
   return {state:'accepted',providerId:result.providerId};
  };
  return await Promise.race([
   Promise.resolve().then(work),
   new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('unknown'));},5000);}),
  ]);
 } catch {return {state:'unknown',providerId:null};}
 finally {clearTimeout(timer);controller.abort();}
}
