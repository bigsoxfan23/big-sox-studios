// Staging-only source. No production entrypoint imports this directory.
export const PINS=Object.freeze({
 ownerHost:'bss-owner-launchpad-staging.fridman-greg.workers.dev',
 memberHost:'members-staging.bigsoxstudios.com',
 issuer:'https://old-hill-995d.cloudflareaccess.com',
 ownerAudience:'0ac97e12ea497b28dee6aa43e7b63b8a73ee9edd48579e965c0baec3ea72ed64',
 memberAudience:'f3ad2eeca58fc7e607b96e47b28672b78a920d34474f97a15e56a6235fc1cdbe',
 requestsId:'5f333c95-de64-4a37-8467-8a0bbba7dd9b',
 membersId:'adf83cdc-e8df-4cc4-acd5-3f89ce6f34ea',
 parent:'423013a6-47c5-81f8-8bea-cb3730ca4d88',
 owner:'fridman.greg@gmail.com', tester:'greg.fridman@outlook.com',
 sender:'support@bigsoxstudios.com', senderDomain:'bigsoxstudios.com',
 revision:'task12-private-acceptance-v1', attemptBudget:1,
});
export const sha256=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
export const must=condition=>{if(!condition) throw Error('acceptance unavailable');};
export const seconds=()=>Math.floor(Date.now()/1000);
export const stmt=(db,sql,...args)=>db.prepare(sql).bind(...args);
// D1 counts trigger writes too. Every caller targets one unique primary key;
// a zero-row CAS fires no trigger, while successful audited writes may report >1.
export const changed=result=>Number.isSafeInteger(result?.meta?.changes) && result.meta.changes>0;
const binding=db=>db && typeof db.prepare==='function' && typeof db.batch==='function';
export async function guard(env) {
 must(env?.ACCEPTANCE_MODE==='private-staging-source' && env.ACCEPTANCE_REVISION===PINS.revision &&
  env.ACCEPTANCE_REQUESTS_ID===PINS.requestsId && env.ACCEPTANCE_MEMBERS_ID===PINS.membersId &&
  binding(env.ACCEPTANCE_REQUESTS) && binding(env.ACCEPTANCE_MEMBERS) && env.ACCEPTANCE_REQUESTS!==env.ACCEPTANCE_MEMBERS);
 // Refuse legacy binding objects BEFORE touching any database.
 for(const key of ['DB','MEMBERSHIP_DB','APPROVED_REQUESTS_DB','MEMBERS_DB','REQUESTS_DB'])
  must(!env[key] || (env[key]!==env.ACCEPTANCE_REQUESTS && env[key]!==env.ACCEPTANCE_MEMBERS));
 must(env.ACCEPTANCE_OWNER_RECIPIENT===PINS.owner && env.ACCEPTANCE_TEST_RECIPIENT===PINS.tester);
 must(/^[A-Za-z0-9_-]{43}$/.test(env.ACCEPTANCE_CSRF_KEY) && /^[A-Za-z0-9_-]{43}$/.test(env.ACCEPTANCE_RUN_NONCE) &&
  env.ACCEPTANCE_CSRF_KEY!==env.ACCEPTANCE_RUN_NONCE && /^[a-zA-Z0-9_-]{16,64}$/.test(env.ACCEPTANCE_RUN_ID));
 // Binding IDs alone cannot attest the physical database: require installed markers too.
 const [r,m]=await Promise.all([
  stmt(env.ACCEPTANCE_REQUESTS,'SELECT id FROM acceptance_database_identity').first(),
  stmt(env.ACCEPTANCE_MEMBERS,'SELECT id FROM acceptance_database_identity').first(),
 ]);
 must(r?.id===PINS.requestsId && m?.id===PINS.membersId);
 must((await stmt(env.ACCEPTANCE_MEMBERS,'SELECT count(*) AS n FROM service_grants').first())?.n===0);
 const run=await stmt(env.ACCEPTANCE_REQUESTS,'SELECT * FROM acceptance_run WHERE singleton=1').first();
 const nonceDigest=await sha256(env.ACCEPTANCE_RUN_NONCE);
 must(!run || (run.run_id===env.ACCEPTANCE_RUN_ID && run.nonce_digest===nonceDigest));
 return {requests:env.ACCEPTANCE_REQUESTS,members:env.ACCEPTANCE_MEMBERS,runId:env.ACCEPTANCE_RUN_ID,nonceDigest};
}
