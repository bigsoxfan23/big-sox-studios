import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,NoOpLog,convertV4MiniflareOptions} from 'miniflare';
import {applySchema,envConfig,epoch,jwk,token,identityClaims} from './test-support.mjs';

test('OFFLINE: complete Worker executes WebCrypto/JWKS/identity/live D1 in workerd with no outbound traffic',async t=>{
 const modules=['worker','access','identity','repository','authorization','projection','access-policy-readback'].map(name=>({type:'ESModule',path:`portal/${name}.mjs`,contents:readFileSync(new URL(`./${name}.mjs`,import.meta.url),'utf8')}));
 const entry=`import {createWorker} from './portal/worker.mjs';
 const worker=createWorker({now:()=>${epoch}000,fetcher:async()=>Response.json({keys:[${JSON.stringify(jwk)}]}),
 resolveVerifiedIdentity:async claims=>({...claims.syntheticIdentity,accessSubject:claims.sub,expiresAt:claims.exp})});
 // Miniflare uses a loopback transport Host; reconstruct the synthetic edge
 // request from its preserved URL. Spoofed Host denial is tested separately.
 export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host',new URL(request.url).host);
 return worker.fetch(new Request(request,{headers}),{...env,...${JSON.stringify(envConfig)}});}};`;
 const mf=new Miniflare(convertV4MiniflareOptions({name:'portal-runtime-offline',log:new NoOpLog(),compatibilityDate:'2026-10-24',d1Databases:{DB:'portal-runtime-synthetic'},
  modules:[{type:'ESModule',path:'entry.mjs',contents:entry},...modules],outboundService:()=>{throw Error('no outbound traffic allowed');}}));
 t.after(()=>mf.dispose()); const db=await mf.getD1Database('DB'); await applySchema(db);
 await db.prepare("INSERT INTO members VALUES('synthetic','person@example.test','member','active',?)").bind(epoch).run();
 await db.prepare("INSERT INTO identities VALUES('google','subject-one','synthetic',?)").bind(epoch).run();
 const headers={'Cf-Access-Jwt-Assertion':token(identityClaims())};
 const get=path=>mf.dispatchFetch(envConfig.APP_ORIGIN+path,{headers});
 const first=await get('/'); assert.equal(first.status,200,await first.text());
 assert.equal((await get('/api/services/jellyfin')).status,403);
 await db.prepare("INSERT INTO service_grants VALUES('synthetic','jellyfin')").run();
 assert.equal((await get('/api/services/jellyfin')).status,200);
 await db.prepare("UPDATE members SET status='revoked' WHERE id='synthetic'").run();
 assert.equal((await get('/')).status,403); assert.equal((await get('/api/services/jellyfin')).status,403);
 assert.equal((await mf.dispatchFetch('https://unknown.example.test/',{headers})).status,403);
});
