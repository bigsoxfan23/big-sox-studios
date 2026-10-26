import {ACCESS_ISSUER,AUDIENCES,createStagingWorker} from './worker.mjs';
import {createAuthenticator} from '../portal/access.mjs';
import {createMemberDashboard} from '../portal/member-dashboard.mjs';

const host='members-staging.bigsoxstudios.com';
export const dashboardConfig=Object.freeze({
 ACCESS_ISSUER,
 ACCESS_AUDIENCE:AUDIENCES[host],
 APP_ORIGIN:`https://${host}`,
 OTP_CUSTOM_HOSTS:Object.freeze([host])
});

// Source-only composition. The deployed staging config still selects worker.mjs.
export function createStagingDashboard({fetcher=fetch,now=()=>Date.now()}={}) {
 const dashboard=createMemberDashboard({
  verifyAccess:createAuthenticator({fetcher,now}),now,mountPath:'/app'
 });
 return createStagingWorker({memberApp:{fetch(request,env,ctx){
  // These targets come from source, not configurable audiences or host aliases.
  return dashboard.fetch(request,{...env,...dashboardConfig},ctx);
 }}});
}

// Selecting this entrypoint requires a separate reviewed rollout.
export default createStagingDashboard();
