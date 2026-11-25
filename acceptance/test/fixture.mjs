import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync,createSign,randomBytes} from 'node:crypto';
import {PINS} from '../config.mjs';
import {preflightFixture,signAttestation} from './attestation-fixture.mjs';
import {createAcceptanceWorker} from '../worker.mjs';
import {createMemberAcceptanceEntry} from '../../members-portal-staging/private-acceptance-entry.mjs';
import {createOwnerAcceptanceEntry} from '../../owner-launchpad/src/private-acceptance-entry.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'local-only',alg:'RS256',use:'sig'};
// In-memory SQLite implements D1 binding methods, transactional batch and actual
// database unixepoch(), constraints and triggers. No network or real D1 involved.
export class LocalD1 {
 constructor(sql){this.sqlite=new DatabaseSync(':memory:');this.sqlite.exec(sql);this.hook=null;this.touches=0;}
 prepare(sql){
  const db=this;let args=[];
  return {bind(...values){args=values;return this;},async first(){await db.before(sql);return db.sqlite.prepare(sql).get(...args)||null;},
   async all(){await db.before(sql);return {results:db.sqlite.prepare(sql).all(...args)};},
   async run(){await db.before(sql);return db.execute(sql,args);},_raw(){return db.execute(sql,args);}};
 }
 async before(sql){this.touches++;if(this.hook)await this.hook(sql);}
 async batch(statements){await this.before('BATCH');this.sqlite.exec('BEGIN');try{const result=statements.map(s=>s._raw());this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
 execute(sql,args){const before=this.sqlite.prepare('SELECT total_changes() AS n').get().n;this.sqlite.prepare(sql).run(...args);return {meta:{changes:this.sqlite.prepare('SELECT total_changes() AS n').get().n-before}};}
 close(){this.sqlite.close();}
 rows(table){return this.sqlite.prepare(`SELECT * FROM ${table}`).all();}
}
export function makeDb(kind,withDelta=true){
 const sql=readFileSync(new URL(`../${kind}.sql`,import.meta.url),'utf8');
 const delta=readFileSync(new URL(`../migration-0002-${kind}.sql`,import.meta.url),'utf8');
 return new LocalD1(sql+(withDelta?delta:''));
}
export function fixture(t,options={}) {
 const requests=makeDb('requests'),members=makeDb('members');t.after(()=>{requests.close();members.close();});
 const at=Math.floor(Date.now()/1000);let clock=at*1000;
 const env={ACCEPTANCE_ATTESTATION_KEY:randomBytes(32).toString('base64url'),ACCEPTANCE_VERIFIED_SENDER:PINS.sender,ACCEPTANCE_MODE:'private-staging-source',ACCEPTANCE_REVISION:PINS.revision,
  ACCEPTANCE_REQUESTS_ID:PINS.requestsId,ACCEPTANCE_MEMBERS_ID:PINS.membersId,ACCEPTANCE_REQUESTS:requests,ACCEPTANCE_MEMBERS:members,
  ACCEPTANCE_OWNER_RECIPIENT:PINS.owner,ACCEPTANCE_TEST_RECIPIENT:PINS.tester,
  ACCEPTANCE_CSRF_KEY:randomBytes(32).toString('base64url'),ACCEPTANCE_RUN_NONCE:randomBytes(32).toString('base64url'),ACCEPTANCE_RUN_ID:'synthetic-run-0001',
  ACCEPTANCE_NOTION_PARENT:PINS.parent,ACCEPTANCE_NOTION_CREDENTIAL:'synthetic-notion-credential-does-not-exist',
  ACCEPTANCE_SENDER_CREDENTIAL:'synthetic-sender-credential-does-not-exist',ACCEPTANCE_DISPATCH_GATE:'greg-one-run:synthetic-run-0001'};
 const preflight=preflightFixture(env,at);
 const readTrustedPreflight=async()=>preflight;
 const calls=[];let providerResult='accepted';let scope=true;let receipt=true;
 const providers={
  async verifyScope(input){return scope?{parent:input.parent,runId:input.runId,pageOnly:true,privateParent:true,stagingOnly:true,sendingOnly:true,senderVerified:true,zeroSpend:true,recipientPinsVerified:true,expiresAt:at+600}:null;},
  async createTicket(payload){calls.push({kind:'notion_ticket',payload});return {state:providerResult,providerId:'local-ticket'};},
  async send(payload){calls.push({kind:payload.to===PINS.owner?'owner_notice':'test_welcome',payload});return {state:providerResult,providerId:payload.to===PINS.owner?'local-notice':'local-welcome'};},
  async verifyReceipt(){return receipt;},
 };
 const now=()=>clock;
 const fetcher=async (url,init)=>{if(url===`${PINS.issuer}/cdn-cgi/access/certs`)return Response.json({keys:[jwk]});if(options.wireFetcher)return options.wireFetcher(url,init);throw Error('network forbidden');};
 const verifyAccessPolicy=async({claims,runId})=>({mfaVerified:true,policyVerified:true,allowlistVerified:true,bindingsVerified:true,requestsId:PINS.requestsId,membersId:PINS.membersId,ownerHost:PINS.ownerHost,memberHost:PINS.memberHost,subject:claims.sub,audience:Array.isArray(claims.aud)?claims.aud[0]:claims.aud,runId,expiresAt:claims.exp});
 const baseCalls=[];const base={async fetch(req,environment,ctx){baseCalls.push({req,environment,ctx});return new Response('unchanged original route',{headers:{'Set-Cookie':'original=unchanged'}});}};
 const config={now,fetcher,verifyAccessPolicy,readTrustedPreflight,providers,base,...options,...(options.realAdapters?{providers:undefined}:{})};
 const owner=options.entries?createOwnerAcceptanceEntry(config):createAcceptanceWorker({...config,role:'owner'});
 const member=options.entries?createMemberAcceptanceEntry(config):createAcceptanceWorker({...config,role:'member'});
 function jwt(role,changes={}){
  const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const input=`${encode({alg:'RS256',kid:jwk.kid})}.${encode({iss:PINS.issuer,aud:[role==='owner'?PINS.ownerAudience:PINS.memberAudience],email:role==='owner'?PINS.owner:PINS.tester,sub:`local-${role}`,iat:at-10,nbf:at-10,exp:at+300,...changes})}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
 }
 const tokens={owner:jwt('owner'),member:jwt('member')};
 function context(role,email=role==='owner'?PINS.owner:PINS.tester){return {access:{aud:role==='owner'?PINS.ownerAudience:PINS.memberAudience,getIdentity:async()=>({email,idp:{type:role==='member'?'onetimepin':'google'}})}};}
 async function get(role,path,extra={}){
  const origin=`https://${role==='owner'?PINS.ownerHost:PINS.memberHost}`;
  const req=new Request((extra.origin||origin)+path,{headers:{'Cf-Access-Jwt-Assertion':extra.token||tokens[role],...extra.headers}});
  let attestation;try{attestation=signAttestation(env,preflight,extra.token||tokens[role],at);}catch{/* Invalid synthetic JWT; runtime signature verification will deny. */}
  return (role==='owner'?owner:member).fetch(req,{...env,ACCEPTANCE_OPERATOR_ATTESTATION:attestation,...extra.env},extra.ctx||context(role));
 }
 async function form(role,path){const res=await get(role,path);const body=await res.text();const csrf=/name="csrf" value="([^"]+)"/.exec(body)?.[1];return {res,body,csrf,cookie:res.headers.get('Set-Cookie')?.split(';')[0]};}
 async function post(role,path,formState,values={},extra={}){
  const origin=`https://${role==='owner'?PINS.ownerHost:PINS.memberHost}`;
  const body=new URLSearchParams({csrf:formState?.csrf||'',source_revision:PINS.revision,revision:'1',confirm:'TEST',...values});
  const req=new Request(origin+path,{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/x-www-form-urlencoded',Cookie:formState?.cookie||'','Cf-Access-Jwt-Assertion':extra.token||tokens[role],...extra.headers},body:extra.body||body});
  let attestation;try{attestation=signAttestation(env,preflight,extra.token||tokens[role],at);}catch{/* Invalid synthetic JWT; runtime signature verification will deny. */}
  return (role==='owner'?owner:member).fetch(req,{...env,ACCEPTANCE_OPERATOR_ATTESTATION:attestation,...extra.env},extra.ctx||context(role));
 }
 async function submit(){const f=await form('member','/acceptance/request');const res=await post('member','/acceptance/request',f);return {res,id:requests.rows('acceptance_requests')[0]?.id};}
 async function dispatch(id){const f=await form('owner','/acceptance/requests/');return post('owner',`/acceptance/requests/${id}/dispatch`,f,{confirm:PINS.owner});}
 async function approve(id){const f=await form('owner','/acceptance/requests/');return post('owner',`/acceptance/requests/${id}/decision`,f);}
 async function welcome(id){const f=await form('owner',`/acceptance/requests/${id}/send-welcome`);return post('owner',`/acceptance/requests/${id}/send-welcome`,f,{revision:'2',confirm:PINS.tester});}
 return {env,preflight,readTrustedPreflight,requests,members,calls,baseCalls,owner,member,now,jwt,tokens,context,get,form,post,submit,dispatch,approve,welcome,providers,
  time:value=>{clock=value;},at,result:value=>{providerResult=value;},scope:value=>{scope=value;},receipt:value=>{receipt=value;}};
}
