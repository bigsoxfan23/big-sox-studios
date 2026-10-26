import {readFileSync} from 'node:fs';
import {generateKeyPairSync,createSign} from 'node:crypto';
import {Miniflare,NoOpLog,convertV4MiniflareOptions} from 'miniflare';
import {createRepository} from './repository.mjs';
import {createAuthenticator} from './access.mjs';
import {createIdentityAuthenticator} from './identity.mjs';
import {createOfflineProjection,projectAndReadback,desiredProjection} from './projection.mjs';
export const epoch=1800000000;
export const envConfig={ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',ACCESS_AUDIENCE:'members-test',OWNER_ACCESS_AUDIENCE:'owner-test',APP_ORIGIN:'https://members.example.test',PORTAL_MODE:'offline-test',INVITE_SERVICE:{}};
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
export const jwk={...publicKey.export({format:'jwk'}),kid:'synthetic-key',alg:'RS256',use:'sig'};
export const certFetch=async()=>Response.json({keys:[jwk]});
export function token(changes={}) {
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const input=`${encode({alg:'RS256',kid:jwk.kid})}.${encode({iss:envConfig.ACCESS_ISSUER,aud:['members-test'],sub:'access-session',iat:epoch,nbf:epoch,exp:epoch+700000,email:'person@example.test',...changes})}`;
 return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}
export function request(jwt=token(),path='/',origin=envConfig.APP_ORIGIN,extra={}) {
 return new Request(origin+path,{headers:{'Cf-Access-Jwt-Assertion':jwt,...extra}});
}
// SYNTHETIC ONLY signed custom claim contract. NOT an Access provider mapping.
export const resolver=async claims=>({...claims.syntheticIdentity,accessSubject:claims.sub,expiresAt:claims.exp});
export function identityClaims(provider='google',subject='subject-one',email='person@example.test',changes={}) {
 return {syntheticIdentity:{provider,subject,email,emailVerified:true,stableSubjectVerified:true,mfaVerified:true,...changes}};
}
export async function fixture(t) {
 const mf=new Miniflare(convertV4MiniflareOptions({log:new NoOpLog(),name:'task12-offline',modules:true,
  script:'export default {fetch(){return new Response(null,{status:404});}}',compatibilityDate:'2026-10-24',d1Databases:{DB:'task12-synthetic-only'}}));
 t.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB');
 await applySchema(db);
 await db.prepare("INSERT INTO members VALUES('owner','owner@example.test','owner','active',?)").bind(epoch).run();
 let at=epoch;
 const repo=createRepository(db,{now:()=>at});
 const authenticate=createIdentityAuthenticator({authenticate:createAuthenticator({fetcher:certFetch,now:()=>at*1000}),resolveVerifiedIdentity:resolver});
 const identity=async(provider='google',subject='subject-one',email='person@example.test',changes={})=>authenticate(request(token(identityClaims(provider,subject,email,changes))),envConfig);
 const adapter=createOfflineProjection();
 // Existing owner projection must also be included in complete reconciliation.
 await adapter.project((await desiredProjection(db,at))[0]);
 async function pending(email='person@example.test') { return repo.createPending('owner',email); }
 async function ready(memberId) {
  const invite=await repo.issue('owner',memberId);
  for (const entry of await desiredProjection(db,at)) await adapter.project(entry);
  await repo.confirmProjection('owner',invite.id,await projectAndReadback(db,adapter,invite.id,at));
  await repo.confirmOwnerDelivery('owner',invite.id); return invite;
 }
 return {mf,db,repo,identity,adapter,pending,ready,time:value=>{at=value;},now:()=>at};
}

export async function applySchema(db,file='./schema.sql') {
 let sql=readFileSync(new URL(file,import.meta.url),'utf8').replace(/^--.*$/gm,'').trim();
 const statements=[];
 while(sql) {
  let end;
  if(sql.startsWith('CREATE TRIGGER')) {
   const first=sql.indexOf('\n');
   end=sql.slice(0,first).endsWith('END;')?first:sql.indexOf('\nEND;')+5;
  } else end=sql.indexOf(';')+1;
  if(end<=0) throw Error('schema split');
  statements.push(db.prepare(sql.slice(0,end))); sql=sql.slice(end).trim();
 }
 await db.batch(statements);
}
