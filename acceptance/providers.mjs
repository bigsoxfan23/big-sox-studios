import {PINS,must} from './config.mjs';
// No default network transport or scope verifier. These are trusted server-side
// adapters, never bindings selected by a request or an env readiness boolean.
// Synthetic tests inject deterministic fakes. Future real adapters require review.
export async function verifiedProviders(providers,env,session,now) {
 must(env.ACCEPTANCE_DISPATCH_GATE===`greg-one-run:${env.ACCEPTANCE_RUN_ID}` &&
  env.ACCEPTANCE_NOTION_PARENT===PINS.parent && env.ACCEPTANCE_OWNER_RECIPIENT===PINS.owner && env.ACCEPTANCE_TEST_RECIPIENT===PINS.tester &&
  typeof env.ACCEPTANCE_NOTION_CREDENTIAL==='string' && env.ACCEPTANCE_NOTION_CREDENTIAL.length>=32 &&
  typeof env.ACCEPTANCE_SENDER_CREDENTIAL==='string' && env.ACCEPTANCE_SENDER_CREDENTIAL.length>=32 &&
  env.ACCEPTANCE_NOTION_CREDENTIAL!==env.ACCEPTANCE_SENDER_CREDENTIAL &&
  typeof providers?.verifyScope==='function' && typeof providers?.createTicket==='function' &&
  typeof providers?.send==='function' && typeof providers?.verifyReceipt==='function');
 const proof=await providers.verifyScope({notionCredential:env.ACCEPTANCE_NOTION_CREDENTIAL,senderCredential:env.ACCEPTANCE_SENDER_CREDENTIAL,
  parent:PINS.parent,runId:env.ACCEPTANCE_RUN_ID,owner:PINS.owner,tester:PINS.tester});
 must(proof?.parent===PINS.parent && proof.runId===env.ACCEPTANCE_RUN_ID && proof.pageOnly===true && proof.privateParent===true &&
  proof.stagingOnly===true && proof.sendingOnly===true && proof.senderVerified===true && proof.zeroSpend===true &&
  proof.recipientPinsVerified===true && Number.isSafeInteger(proof.expiresAt) && proof.expiresAt>Math.floor(now()/1000) && session.expiresAt>Math.floor(now()/1000));
 return proof;
}
export function providerPayload(kind,request,id,recipient) {
 // Fixed allowlisted shape: never raw applicant text, headers, CC/BCC or reply-to.
 if(kind==='notion_ticket') return Object.freeze({parent:PINS.parent,title:'Task12 Acceptance — TEST Ticket',runId:request.run_id,requestId:request.id,status:'pending',intentId:id});
 return Object.freeze({to:kind==='owner_notice'?PINS.owner:PINS.tester,recipientDigest:recipient,
  subject:kind==='owner_notice'?'TEST request awaiting review':'TEST welcome — no service access',
  text:kind==='owner_notice'?`TEST request ${request.id}. Review https://${PINS.ownerHost}/acceptance/requests/`:
   `TEST welcome. No Jellyfin or other service access. https://${PINS.memberHost}/acceptance/app`,intentId:id});
}
export async function once(providers,kind,payload,credential) {
 // Timeout/crash can never free the durable reservation. Late results are ignored.
 const controller=new AbortController();let timer;
 try {
  const work=async()=>{
   const result=await (kind==='notion_ticket'?providers.createTicket(payload,{credential,signal:controller.signal}):providers.send(payload,{credential,signal:controller.signal}));
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
