import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createRequestOnboarding} from '../request-onboarding.mjs';
import {createWelcomeReview} from '../welcome-review.mjs';
import {createWelcomeLiveDelivery} from '../welcome-live-delivery.mjs';
import {createWelcomeReconciliation,welcomeReconciliationProofValue} from '../welcome-reconciliation.mjs';
export const sql = path => readFileSync(new URL('../../'+path,import.meta.url),'utf8');
// schema.sql already contains 0002. Apply the remaining exact baseline files;
// do not rewrite/split trigger SQL to approximate a migration.
export const baseline = ['portal/schema.sql','portal/migrations/0001-first-owner-bootstrap.sql',
 'portal/migrations/0003-invitation-claim-nonces.sql','portal/migrations/0004-request-onboarding.sql',
 'portal/migrations/0005-welcome-intents.sql','portal/migrations/0007-owner-admission-withdrawal-holds.sql'];
export const migration = 'portal/migrations/0006-welcome-reconciliation.sql';
export const content = Object.freeze({message:'Welcome, synthetic friend!',password:'synthetic-only-password'});
export const providerId = '550e8400-e29b-41d4-a716-446655440011';
export function d1(sqlite,hooks={}) {
 const wrap=(query,args=[])=>({
  bind(...values) { return wrap(query,values); },
  async first() { await hooks.before?.(query,args); const row=sqlite.prepare(query).get(...args)||null; await hooks.after?.(query,args,row); return row; },
  async all() { await hooks.before?.(query,args); return {results:sqlite.prepare(query).all(...args)}; },
  async run() { await hooks.before?.(query,args); return sqlite.prepare(query).run(...args); }
 });
 return {prepare:query=>wrap(query),async batch(statements) {
  sqlite.exec('BEGIN'); try { const rows=[]; for (const stmt of statements) rows.push(await stmt.run()); sqlite.exec('COMMIT'); return rows; }
  catch (error) { sqlite.exec('ROLLBACK'); throw error; }
 }};
}
export function rows(db) {
 return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
}
export async function fixture(t,overrides={}) {
 const requests=new DatabaseSync(':memory:'),members=new DatabaseSync(':memory:');
 t.after(()=>{requests.close();members.close();});
 t.mock.method(globalThis,'fetch',()=>{throw Error('Network forbidden in source-only tests');});
 requests.exec(sql('membership/migrations/0001_membership.sql'));
 for (const path of baseline) members.exec(sql(path));
 const at=Math.floor(Date.now()/1000),clock={at},hooks={};
 members.prepare("INSERT INTO members VALUES('owner','owner@example.test','owner','active',?)").run(at);
 requests.prepare(`INSERT INTO membership_requests(id,email_hash,email,status,created_at,updated_at)
  VALUES('request','synthetic-hash','friend@example.test','approved',?,?)`).run(at*1000,at*1000);
 const memberDb=d1(members,hooks);
 const base={memberDb,sourceDatabase:'source',actorId:'owner',expiresAt:at+600,now:()=>clock.at};
 const onboarding=createRequestOnboarding({...base,requestDb:d1(requests),jellyfinOrigin:'https://jellyfin.example.test'});
 await onboarding.link('request',1);
 await onboarding.markJellyfinReady('request',1,{expectedRevision:1,confirmed:true,username:'friend',url:'https://jellyfin.example.test/'});
 const reviewOptions={onboarding,actorId:'owner',sessionBinding:'s'.repeat(64),signingKey:'k'.repeat(64),expiresAt:base.expiresAt,
  jellyfinOrigin:'https://jellyfin.example.test',memberLoginUrl:'https://members.example.test/app',now:base.now};
 const review=createWelcomeReview(reviewOptions),calls={send:[],inspect:[]};
 const adapter={async send(mail) { calls.send.push(mail); return {state:'accepted',providerId}; },
  async inspect(receipt) { calls.inspect.push(receipt); return {state:'provider-observed',providerId:receipt.providerId,providerStatus:'delivered',text:'DO-NOT-PERSIST'}; }};
 members.exec(sql(migration));
 const options={...base,enabled:true,onboarding,review,adapter,...overrides};
 const api=createWelcomeLiveDelivery(options);
 const reconcileOptions={...base,enabled:true,adapter,sessionBinding:reviewOptions.sessionBinding,signingKey:reviewOptions.signingKey};
 const reconciliation=createWelcomeReconciliation(reconcileOptions);
 const confirmation={review:(await review.preview('request',1,content)).review,confirmed:true};
 const send=(proof=confirmation,extra)=>api.send('request',1,content,proof,extra);
 const count=table=>members.prepare(`SELECT count(*) n FROM ${table}`).get().n;
 const fresh=async()=>({review:(await review.preview('request',1,content)).review,confirmed:true});
 // Synthetic signer stands in for the explicitly absent future authenticated
 // Owner route. Production exports only a verifier and canonical proof value.
 async function sign(evidence,change={},context={}) {
  const proof={issuedAt:clock.at,expiresAt:Math.min(clock.at+120,base.expiresAt),nonce:'a'.repeat(32),...change};
  const value=welcomeReconciliationProofValue({...reconcileOptions,...context,evidence,...proof});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(context.signingKey ?? reconcileOptions.signingKey),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=[...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  return {...proof,signature,confirmed:true};
 }
 return {requests,members,hooks,clock,memberDb,base,options,api,adapter,calls,onboarding,review,reviewOptions,
  reconcileOptions,reconciliation,confirmation,send,fresh,count,sign};
}
