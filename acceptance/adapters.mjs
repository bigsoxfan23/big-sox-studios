// Real wire formats, staging graph only. Never invoke without independently
// reviewed evidence + verified HMAC operator attestation. Tests inject local fetch.
import {PINS,must,sha256} from './config.mjs';
import {requireAttestation} from './attestation.mjs';
import {providerPayload} from './providers.mjs';
const notion='https://api.notion.com/v1/pages';
const resend='https://api.resend.com/emails';
const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const page=(value,id)=>value?.object==='page' && value.id===id && value.archived===false && value.in_trash===false && value.public_url===null;
const exact=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Bounds apply to all receipt bodies. No provider error/body is logged or echoed.
async function json(response) {
 must(response?.status===200 && !response.redirected && /application\/json/i.test(response.headers.get('Content-Type')||''));
 const reader=response.body?.getReader();must(reader);const chunks=[];let size=0;
 try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;must(size<=65536);chunks.push(value);}}
 finally {await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export function createStagingProviders({fetcher=fetch,now=()=>Date.now()}={}) {
 const receipts=new WeakMap();
 async function scope(credential,attestation,kind) {
  const proof=requireAttestation(attestation,now).preflight;
  must(proof[kind].credentialDigest===await sha256(credential));
  return proof;
 }
 async function notionCall(url,credential,signal,body,method=body?'POST':'GET') {
  must(url===`${notion}/${PINS.parent}` || url===notion || url.startsWith(`${notion}/`) && uuid(url.slice(notion.length+1)));
  must((method==='POST' && url===notion) || (method==='GET' && url!==notion) ||
   (method==='PATCH' && url!==notion && url!==(notion+'/'+PINS.parent)));
  return json(await fetcher(url,{method,redirect:'manual',signal,
   headers:{Authorization:`Bearer ${credential}`,'Notion-Version':'2022-06-28',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}));
 }
 return {
  async verifyScope({notionCredential,senderCredential,parent,runId,owner,tester,attestation}) {
   const proof=await scope(notionCredential,attestation,'notion');await scope(senderCredential,attestation,'resend');
   must(parent===PINS.parent && runId===proof.runId && owner===PINS.owner && tester===PINS.tester);
   return {parent,runId,pageOnly:true,privateParent:true,stagingOnly:true,sendingOnly:true,senderVerified:true,zeroSpend:true,
    recipientPinsVerified:true,expiresAt:attestation.expiresAt};
  },
  async createTicket(payload,{credential,attestation,signal}) {
   const proof=await scope(credential,attestation,'notion');
   must(uuid(payload.requestId) && uuid(payload.intentId) && payload.runId===proof.runId &&
    exact(payload,providerPayload('notion_ticket',{id:payload.requestId,run_id:payload.runId},payload.intentId)));
   // Check the exact private destination before the single irreversible POST.
   const parent=await notionCall(`${notion}/${PINS.parent}`,credential,signal);
   must(page(parent,PINS.parent));requireAttestation(attestation,now);must(!signal.aborted);
   const title=[{type:'text',text:{content:payload.title}}];
   const result=await notionCall(notion,credential,signal,{parent:{type:'page_id',page_id:PINS.parent},
    properties:{title:{type:'title',title}},children:[{object:'block',type:'paragraph',paragraph:{rich_text:[{type:'text',text:{content:`TEST only. No service grants. Run ${payload.runId}; request ${payload.requestId}; intent ${payload.intentId}; decision pending; recorded ${new Date(now()).toISOString()}.`}}]}}]});
   must(uuid(result.id) && page(result,result.id) && result.parent?.type==='page_id' && result.parent.page_id===PINS.parent);
   const receipt=Object.freeze({state:'accepted',providerId:result.id});
   receipts.set(receipt,{kind:'notion_ticket',payload,credential,attestation});return receipt;
  },
  async updateTicket(payload,{credential,attestation,signal}) {
   const proof=await scope(credential,attestation,'notion');
   must(uuid(payload.requestId) && uuid(payload.intentId) && uuid(payload.pageId) &&
    payload.pageId!==PINS.parent && payload.runId===proof.runId &&
    ['approved','revoked'].includes(payload.decision) &&
    Number.isSafeInteger(payload.decisionAt) && payload.decisionAt>0 &&
    exact(payload,providerPayload('notion_decision',{
     id:payload.requestId,run_id:payload.runId,page_id:payload.pageId,
     decision:payload.decision,decision_at:payload.decisionAt},payload.intentId)));
   // Read-only verify the exact child/parent/title before one irreversible PATCH.
   const child=await notionCall(notion+'/'+payload.pageId,credential,signal);
   const oldTitle=child.properties?.title?.title?.map(p=>p.plain_text??p.text?.content).join('');
   must(page(child,payload.pageId) && child.parent?.type==='page_id' &&
    child.parent.page_id===PINS.parent && oldTitle?.startsWith('TEST · Task12 Acceptance'));
   requireAttestation(attestation,now);must(!signal.aborted);
   const result=await notionCall(notion+'/'+payload.pageId,credential,signal,{
    properties:{title:{type:'title',title:[{type:'text',text:{content:payload.title}}]}}
   },'PATCH');
   must(page(result,payload.pageId) && result.parent?.type==='page_id' && result.parent.page_id===PINS.parent);
   const receipt=Object.freeze({state:'accepted',providerId:payload.pageId});
   receipts.set(receipt,{kind:'notion_decision',payload,credential,attestation});return receipt;
  },
  async send(payload,{credential,attestation,signal}) {
   await scope(credential,attestation,'resend');
   must(uuid(payload.intentId));
   const kind=payload.to===PINS.owner?'owner_notice':payload.to===PINS.tester?'test_welcome':null;must(kind);
   // Reconstruct from the fixed text only; no caller-controlled headers/CC/BCC.
   const requestId=kind==='owner_notice'?/^TEST request ([0-9a-f-]{36})\./.exec(payload.text)?.[1]:undefined;
   if(kind==='owner_notice')must(uuid(requestId));
   must(exact(payload,providerPayload(kind,{id:requestId},payload.intentId,payload.recipientDigest)) &&
    payload.recipientDigest===await sha256(payload.to));
   requireAttestation(attestation,now);must(!signal.aborted);
   const result=await json(await fetcher(resend,{method:'POST',redirect:'manual',signal,
    headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json','Idempotency-Key':payload.intentId},
    body:JSON.stringify({from:PINS.sender,to:[payload.to],subject:payload.subject,text:payload.text})}));
   must(uuid(result.id));
   const receipt=Object.freeze({state:'accepted',providerId:result.id});
   receipts.set(receipt,{kind,payload,attestation});return receipt;
  },
  async verifyReceipt({kind,payload,result,signal}) {
   const receipt=receipts.get(result);must(receipt && receipt.kind===kind && receipt.payload===payload);
   receipts.delete(result);requireAttestation(receipt.attestation,now);must(!signal.aborted);
   if(kind==='notion_ticket' || kind==='notion_decision') {
    // Read-only corroboration of original ticket or one bounded decision PATCH.
    const child=await notionCall(`${notion}/${result.providerId}`,receipt.credential,signal);
    must(page(child,result.providerId) && child.parent?.type==='page_id' && child.parent.page_id===PINS.parent &&
     child.properties?.title?.title?.map(part=>part.plain_text??part.text?.content).join('')===payload.title);
   }
   // Sending-only Resend keys cannot retrieve emails. The HTTPS POST 200 + id is
   // the acceptance receipt; no broader credential or delivery claim is needed.
   requireAttestation(receipt.attestation,now);return !signal.aborted;
  },
 };
}
