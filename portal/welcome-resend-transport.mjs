// Source-only Resend transport boundary. Not imported by either deployed Worker.
// It cannot send unless a future reviewed route explicitly enables it and passes
// existing server-side credentials. Never log, draft, or persist message contents.
const URL_SEND = 'https://api.resend.com/emails';
const failure = () => { throw Error('Welcome transport unavailable.'); };
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const email = s => typeof s === 'string' && s.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s) && s === s.toLowerCase();
const senderSafe = s => typeof s === 'string' && s.length <= 254 && !/[\r\n<>]/.test(s) && email(s);
const subject = 'Welcome to Big Sox Studios';
const safeText = s => typeof s === 'string' && s.length > 0 && s.length <= 12000 && [...s].every(c => {
 const n=c.codePointAt(0); return n===9||n===10||n===13||(n>=32&&n!==127);
});
const locked = Object.freeze({state:'UNKNOWN',activationAuthorized:false,mayRetry:false});
const refused = Object.freeze({state:'failed',activationAuthorized:false,mayRetry:false});

// The provider's 24-hour idempotency window is NOT a replacement for the
// persistent welcome_intents lock; even a timeout must never auto-retry.
export function createResendWelcomeTransport({enabled=false,apiKey,sender,fetcher,timeoutMs=8000}={}) {
 if(enabled!==true) return Object.freeze({send:async()=>failure(),inspect:async()=>failure()});
 if(typeof apiKey!=='string'||!/^re_[A-Za-z0-9_]{8,200}$/.test(apiKey)||!senderSafe(sender)
  ||typeof fetcher!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>8000)failure();

 async function exchange(method,resource,body,intentId) {
  const controller=new AbortController();
  let timeout;
  const task=(async()=>{
   const headers={'Authorization':'Bearer '+apiKey,'Accept':'application/json'};
   if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']='bss-welcome/'+intentId;}
   const response=await fetcher(resource,{method,headers,body:body===undefined?undefined:JSON.stringify(body),
    // Cloudflare Workers rejects redirect:'error' before dispatch. 'manual' is
    // supported and lets us fail closed on all 3xx without forwarding secrets.
    signal:controller.signal,redirect:'manual',cache:'no-store'});
   if(!(response instanceof Response)||response.redirected)failure();
   let data=null;
   if(response.status===200){
    const text=await response.text();
    if(text.length<=4096){try{data=JSON.parse(text);}catch{/* untrusted response */}}
   }
   return {status:response.status,data};
  })();
  const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(Error('timeout'));},timeoutMs);});
  try{return await Promise.race([task,deadline]);}
  catch{return null;}
  finally{clearTimeout(timeout);controller.abort();}
 }
 return Object.freeze({
  async send({intentId,recipient,subject:mailSubject,text}={}) {
   if(!uuid(intentId)||!email(recipient)||mailSubject!==subject||!safeText(text))failure();
   const result=await exchange('POST',URL_SEND,{from:sender,to:[recipient],subject,text},intentId);
   if(!result)return locked;
   if(result.status===200&&uuid(result.data?.id))
    return Object.freeze({state:'accepted',providerId:result.data.id,activationAuthorized:false,delivered:false});
   if([400,401,403,422].includes(result.status))return refused;
   return locked;
  },
  // Read-only corroboration when a trusted provider ID is already available.
  // Missing/uncertain ID cannot be guessed; manual Owner reconciliation required.
  async inspect({providerId,recipient}={}) {
   if(!uuid(providerId)||!email(recipient))return locked;
   const result=await exchange('GET',URL_SEND+'/'+providerId,undefined);
   if(result?.status!==200||result.data?.id!==providerId||!Array.isArray(result.data?.to)||
    result.data.to.length!==1||result.data.to[0]!==recipient)return locked;
   const providerStatus=result.data?.last_event;
   if(!['sent','delivered','delivery_delayed','bounced','complained','failed'].includes(providerStatus))return locked;
   return Object.freeze({state:'provider-observed',providerStatus,providerId,activationAuthorized:false,mayRetry:false});
  }
 });
}

// No mutating reconciliation helper is provided: a locked UNKNOWN or dispatching
// row requires Owner-reviewed evidence and a separate audited procedure.
export function welcomeReconciliationStatus(row) {
 if(!row||!['UNKNOWN','dispatching'].includes(row.state)||!['live','simulated'].includes(row.mode))failure();
 return Object.freeze({state:'locked',providerId:uuid(row.provider_id)?row.provider_id:null,
  requiresOwnerReview:true,mayRetry:false,activationAuthorized:false});
}
