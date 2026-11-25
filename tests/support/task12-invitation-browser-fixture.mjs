// LOCAL SYNTHETIC BROWSER FIXTURE ONLY. Never import this module into a Worker.
// No Cloudflare credentials or real identity. Requests are translated into a
// synthetic custom-host request and given test JWT/runtime fixtures server-side.
import http from 'node:http';
import {fixture,epoch,envConfig,token,certFetch,applySchema} from '../../portal/test-support.mjs';
import {createAuthenticator} from '../../portal/access.mjs';
import {createMemberDashboard} from '../../portal/member-dashboard.mjs';
import {desiredProjection,projectAndReadback} from '../../portal/projection.mjs';
const cleanup=[];
const f=await fixture({after:fn=>cleanup.push(fn)});
await applySchema(f.db,'./migrations/0003-invitation-claim-nonces.sql');
await f.db.prepare("INSERT INTO identities VALUES('otp','owner@example.test','owner',?)").bind(epoch).run();
await f.pending();
f.time(Math.floor(Date.now()/1000));
const env={...envConfig,DB:f.db,OTP_CUSTOM_HOSTS:['members.example.test'],PORTAL_OWNER_CONTROLS:'enabled-12-1',PORTAL_INVITATIONS:'enabled-12-2'};
const app=createMemberDashboard({mountPath:'/app',now:()=>Date.now(),verifyAccess:createAuthenticator({fetcher:certFetch,now:()=>Date.now()}),projectInvitation:async(db,id,at)=>{for(const entry of await desiredProjection(db,at))await f.adapter.project(entry);return projectAndReadback(db,f.adapter,id,at);}});
const sessions=new Map();
function jwt(email){if(!sessions.has(email))sessions.set(email,token({email,iat:Math.floor(Date.now()/1000)-1,nbf:Math.floor(Date.now()/1000)-1}));return sessions.get(email);}
const port=Number(process.env.BSS_FIXTURE_PORT||39812),local=`http://localhost:${port}`;
const server=http.createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,local);
  if(['/fixture/owner','/fixture/member','/fixture/wrong'].includes(path.pathname)) {
   const role=path.pathname.split('/').pop();res.writeHead(303,{'Set-Cookie':`bss-fixture-role=${role}; Path=/; SameSite=Strict`,Location:role==='owner'?'/app/manage':'/app/invite'});res.end();return;
  }
  if(path.pathname==='/fixture/status'){
   const count=await f.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='claimed'").first();res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({synthetic:true,successfulClaims:count.n}));return;
  }
  const role=/bss-fixture-role=(member|wrong)/.exec(req.headers.cookie||'')?.[1]||'owner';
  const email=role==='owner'?'owner@example.test':role==='wrong'?'wrong@example.test':'person@example.test';
  const headers=new Headers(req.headers);headers.set('Host','members.example.test');headers.set('Cf-Access-Jwt-Assertion',jwt(email));
  if(headers.get('Origin')===local)headers.set('Origin',envConfig.APP_ORIGIN);
  const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>8192)throw Error('too large');chunks.push(chunk);}
  const request=new Request(envConfig.APP_ORIGIN+path.pathname+path.search,{method:req.method,headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
  const response=await app.fetch(request,env,{access:{aud:env.ACCESS_AUDIENCE,getIdentity:async()=>({email,idp:{type:'onetimepin'}})}});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Local synthetic fixture unavailable');}
});
server.listen(port,'127.0.0.1',()=>console.log('LOCAL SYNTHETIC ONLY: '+local+'/fixture/owner ; switch recipient at /fixture/member ; status /fixture/status'));
async function stop(){server.close();for(const fn of cleanup)await fn();process.exit();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
