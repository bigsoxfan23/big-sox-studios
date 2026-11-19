import {ACCESS_ISSUER,AUDIENCES,createStagingWorker} from './worker.mjs';
import {createAuthenticator} from '../portal/access.mjs';
import {createMemberDashboard} from '../portal/member-dashboard.mjs';
import {createLiveProjection} from '../portal/projection.mjs';

const host='members-staging.bigsoxstudios.com';
export const dashboardConfig=Object.freeze({
 ACCESS_ISSUER,
 ACCESS_AUDIENCE:AUDIENCES[host],
 APP_ORIGIN:`https://${host}`,
 OTP_CUSTOM_HOSTS:Object.freeze([host])
});

// Source-only composition. The deployed staging config still selects worker.mjs.
export function createStagingDashboard({fetcher=fetch,now=()=>Date.now()}={}) {
 const verifyAccess=createAuthenticator({fetcher,now});
 return createStagingWorker({memberApp:{fetch(request,env,ctx){
  // These values are reviewed server configuration, never visitor inputs. A
  // missing/revoked temporary credential blocks issuance, not member login.
  let expectedIdps;
  try{expectedIdps=JSON.parse(env.ACCESS_POLICY_EXPECTED_IDPS);}catch{/* safe-off */}
  const projection=createLiveProjection({fetcher,now:()=>Math.floor(now()/1000),
   token:env.ACCESS_POLICY_READ_TOKEN,recipient:env.ACCESS_POLICY_RECIPIENT,expectedIdps});
  const dashboard=createMemberDashboard({verifyAccess,now,mountPath:'/app',
   projectInvitation:(db,id)=>projection.project(db,id),preflightInvitation:db=>projection.preflight(db)});
  // These targets come from source, not configurable audiences or host aliases.
  return dashboard.fetch(request,{...env,...dashboardConfig},ctx);
 }}});
}

// Selecting this entrypoint requires a separate reviewed rollout.
export default createStagingDashboard();
