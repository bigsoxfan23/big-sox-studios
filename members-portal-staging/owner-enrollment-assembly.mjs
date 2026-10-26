import {createStagingDashboard,dashboardConfig} from './dashboard-assembly.mjs';
import {createAuthenticator} from '../portal/access.mjs';
import {createFirstOwnerEnrollment,enrollmentPath} from '../portal/first-owner-enrollment.mjs';

// Source-only composition. No deployment config selects this module.
export function createStagingOwnerEnrollment({target,verifyPolicy,verifyOwnerApproval,confirmationKey,
 verifyActivation,fetcher=fetch,now=()=>Date.now()}={}) {
 const enrollment=createFirstOwnerEnrollment({target,verifyPolicy,verifyOwnerApproval,confirmationKey,
  verifyAccess:createAuthenticator({fetcher,now}),now});
 const dashboard=createStagingDashboard({verifyActivation,fetcher,now});
 return {fetch(request,env,ctx) {
  if(new URL(request.url).pathname===enrollmentPath)
   return enrollment.fetch(request,{...env,...dashboardConfig},ctx);
  return dashboard.fetch(request,env,ctx);
 }};
}
export default createStagingOwnerEnrollment();
