const HOST='members.bigsoxstudios.com';
const ORIGIN='https://'+HOST;
const ISSUER='https://old-hill-995d.cloudflareaccess.com';
const OWNER_AUDIENCE='e558d6d6d467575e87242a666242f508dc6355e5d0f14f07bb9fa0a808e5b7c0';
const REQUESTS_D1='21e13fa1-0ab3-4573-8d20-983c847ba0e9';
const STAGING_D1='43a8a15b-e195-4712-9198-1dcc9f0152af';
const STAGING_AUDIENCE='f3ad2eeca58fc7e607b96e47b28672b78a920d34474f97a15e56a6235fc1cdbe';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const D1=value=>value&&typeof value.prepare==='function'&&typeof value.batch==='function';

// Exact reviewed production enrollment boundary; no staging defaults or inferred identity.
export const productionOwnerBoundary=Object.freeze({
 origin:ORIGIN,issuer:ISSUER,
 audience:'3bb9e98e55d2950a5f6630460f9f9b4e558eab58582497be3e806bf129a9c6c4',
 databaseId:'613c9c18-69f9-4cf4-b7b1-afb0de49bd6d'
});
export const productionEnrollmentMode='production-enrollment-source';

export function productionBindingsReady(env) {
 if(!env || env.APP_ORIGIN!==ORIGIN || env.ACCESS_ISSUER!==ISSUER ||
    env.OWNER_ACCESS_AUDIENCE!==OWNER_AUDIENCE ||
    typeof env.ACCESS_AUDIENCE!=='string' || !/^[0-9a-f]{64}$/.test(env.ACCESS_AUDIENCE) ||
    env.ACCESS_AUDIENCE===OWNER_AUDIENCE || env.ACCESS_AUDIENCE===STAGING_AUDIENCE ||
    env.APPROVED_REQUESTS_ID!==REQUESTS_D1 ||
    !UUID.test(env.APPROVED_MEMBER_DB_ID) ||
    env.APPROVED_MEMBER_DB_ID===STAGING_D1 ||
    env.APPROVED_MEMBER_DB_ID===REQUESTS_D1 ||
    env.BOOTSTRAP_DATABASE_ID!==env.APPROVED_MEMBER_DB_ID ||
    !Array.isArray(env.OTP_CUSTOM_HOSTS) || env.OTP_CUSTOM_HOSTS.length!==1 ||
    env.OTP_CUSTOM_HOSTS[0]!==HOST ||
    env.PORTAL_PRODUCTION_MODE!=='reviewed-production-12' ||
    env.PORTAL_APPROVED_OTP_ASSEMBLY!=='reviewed-production-12' ||
    env.PORTAL_APPROVED_MEMBERS!=='enabled-12-approved' ||
    env.PORTAL_SIMPLIFIED_MEMBER_UI!=='enabled-12' ||
    !D1(env.DB) || !D1(env.APPROVED_REQUESTS_DB) ||
    env.DB===env.APPROVED_REQUESTS_DB) return false;
 return true;
}

export function productionEnrollmentReady(env) {
 return productionBindingsReady(env) &&
  env.ACCESS_AUDIENCE===productionOwnerBoundary.audience &&
  env.APPROVED_MEMBER_DB_ID===productionOwnerBoundary.databaseId &&
  env.PORTAL_MODE===productionEnrollmentMode &&
  env.PORTAL_OWNER_ENROLLMENT==='reviewed-production-first-owner-12';
}
