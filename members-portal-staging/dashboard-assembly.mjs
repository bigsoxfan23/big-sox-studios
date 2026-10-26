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

// Source composition only: verifyActivation must be a reviewed server adapter,
// never a binding/flag or request value. No real adapter is supplied here.
// Before wiring one, independently approve the existing Phase2 DB binding.
export function createStagingDashboard({verifyActivation,fetcher=fetch,now=()=>Date.now()}={}) {
 const dashboard=createMemberDashboard({
  verifyAccess:createAuthenticator({fetcher,now}),verifyActivation,now,mountPath:'/app'
 });
 return createStagingWorker({memberApp:{fetch(request,env,ctx){
  // These targets come from source, not configurable audiences or host aliases.
  return dashboard.fetch(request,{...env,...dashboardConfig},ctx);
 }}});
}

// Even selecting this entrypoint cannot activate via environment configuration.
export default createStagingDashboard();
