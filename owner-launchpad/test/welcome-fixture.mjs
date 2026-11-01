import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createWorker} from '../src/worker.mjs';
import {b64} from '../src/security.mjs';
import {database,seed} from '../../tests/membership-fixtures.mjs';
const origin='https://bss-owner-launchpad-staging.fridman-greg.workers.dev';
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'setup',use:'sig',alg:'RS256'};
const encode=value=>b64(new TextEncoder().encode(JSON.stringify(value)));
function memberDb(sqlite){const stmt=(sql,args=[])=>({bind(...a){return stmt(sql,a);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return{results:sqlite.prepare(sql).all(...args)};},async run(){return {success:true,meta:{changes:sqlite.prepare(sql).run(...args).changes}};}});return {prepare:sql=>stmt(sql),async batch(statements){sqlite.exec('BEGIN');try{for(const s of statements)await s.run();sqlite.exec('COMMIT');return [];}catch(e){sqlite.exec('ROLLBACK');throw e;}}};}
export async function welcomeFixture(){
 const storage=database(),portal=new DatabaseSync(':memory:');
 portal.exec(readFileSync(new URL('../../portal/schema.sql',import.meta.url),'utf8'));
 portal.exec(readFileSync(new URL('../../portal/migrations/0004-request-onboarding.sql',import.meta.url),'utf8'));
 portal.exec(readFileSync(new URL('../../portal/migrations/0005-welcome-intents.sql',import.meta.url),'utf8'));
 portal.prepare("INSERT INTO members VALUES('owner','owner@example.test','owner','active',?)").run(Math.floor(Date.now()/1000));
 const env={ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',ACCESS_AUDIENCE:'preview-aud',OWNER_EMAIL:'owner@example.test',APP_ORIGIN:origin,MAIL_DESK_URL:'https://mail.example.test/',MEMBERSHIP_DB:storage,MEMBERSHIP_CSRF_KEY:'synthetic-csrf-key-12345678901234567890',PORTAL_DB:memberDb(portal),PORTAL_WELCOME:'simulation-12',PORTAL_ONBOARDING:'staging-12',ONBOARDING_SOURCE_ID:'48b0a0cc-40ad-4495-8883-a42b4a938b71',ONBOARDING_MEMBER_DB_ID:'43a8a15b-e195-4712-9198-1dcc9f0152af',JELLYFIN_ORIGIN:'https://jellyfin.example.test'};
 const worker=createWorker({fetcher:async()=>Response.json({keys:[jwk]})});
 async function token(email=env.OWNER_EMAIL){const at=Math.floor(Date.now()/1000),data=encode({alg:'RS256',kid:'setup'})+'.'+encode({iss:env.ACCESS_ISSUER,aud:[env.ACCESS_AUDIENCE],email,iat:at-1,nbf:at-1,exp:at+600});return data+'.'+b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(data)));}
 const jwt=await token();const request=(path,options={})=>worker.fetch(new Request(origin+path,{...options,headers:{'Cf-Access-Jwt-Assertion':jwt,...options.headers}}),env);
 const form=async path=>{const r=await request(path),html=await r.text();return {r,html,csrf:html.match(/name="csrf" value="([^"]+)"/)?.[1],cookie:r.headers.get('Set-Cookie')?.split(';')[0]};};
 const post=(path,form,fields,headers={})=>request(path,{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/x-www-form-urlencoded',Cookie:form.cookie,...headers},body:new URLSearchParams({csrf:form.csrf,...fields})});
 return {storage,portal,env,request,form,post,token};
}

export {seed};
