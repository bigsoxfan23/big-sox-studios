import {normalizeEmail} from './identity.mjs';

// Pure JSON analysis only. This module deliberately cannot produce a projection
// receipt, authorize a member, enumerate provider users, or mutate any resource.
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 512;
const time = x => Number.isSafeInteger(x) && x >= 0;
const keys = (x, allowed) => object(x) && Object.keys(x).every(k => allowed.includes(k));
const host = x => typeof x === 'string' && x.length <= 253 && /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/.test(x);
const sameSet = (a,b) => Array.isArray(a) && Array.isArray(b) && new Set(a).size === a.length && a.length === b.length && a.every(x => b.includes(x));

export function preflightAccessProjection(input) {
 const findings = [], inventory = [], differences = [];
 const add = (code, ref = 'snapshot') => findings.push({code, ref});
 const result = () => ({mode:'OFFLINE PREFLIGHT', status:'BLOCKED',
  policyAnalysis:findings.length ? 'UNSAFE_OR_UNKNOWN' : 'SUPPORTED_CONTACT_SUBSET',
  reconciliation:findings.length ? 'INCONCLUSIVE' : differences.length ? 'DRIFT' : 'CONTACTS_MATCH_ONLY',
  // These blockers are unconditional: caller flags/labels are not evidence.
  blockers:['PROVIDER_STABLE_SUBJECT_UNPROVEN','LIVE_INVENTORY_UNATTESTED','NOT_A_PROJECTION_RECEIPT'],
  counts:{applications:inventory.filter(x=>x.kind==='application').length,
   groups:inventory.filter(x=>x.kind==='group').length,policies:inventory.filter(x=>'decision' in x).length,
   ruleVisits:inventory.filter(x=>'selector' in x).length,differences:differences.length},
  findings, inventory, differences});
 let data;
 try {
  const encoded = JSON.stringify(input);
  if (!encoded || encoded.length > 1000000) throw Error();
  data = JSON.parse(encoded);
 } catch { add('INVALID_OR_OVERSIZED_JSON'); return result(); }
 try {
  analyze(data);
 } catch {
  // Never echo parser exceptions, input values, IDs, selectors, or contacts.
  add('MALFORMED_SNAPSHOT');
 }
 return result();

 function analyze({now, expectedHosts, expectedIdps, access, hosts, d1Before, d1After}) {
  if (!time(now)) { add('INVALID_TIME'); return; }
  function fresh(snapshot, ref) {
   if (!object(snapshot) || snapshot.complete !== true) add('INCOMPLETE_SNAPSHOT',ref);
   if (!time(snapshot?.capturedAt) || snapshot.capturedAt > now || now-snapshot.capturedAt > 60) add('STALE_OR_FUTURE_SNAPSHOT',ref);
  }
  function envelope(value, ref) {
   // Only one explicitly complete synthetic page is supported. A collector must
   // separately implement/review pagination; a partial page cannot be upgraded.
   if (!keys(value,['success','errors','messages','result','result_info']) || value.success !== true ||
    !Array.isArray(value.errors) || value.errors.length || !Array.isArray(value.messages) || value.messages.length ||
    !Array.isArray(value.result) || !keys(value.result_info,['page','per_page','count','total_count','total_pages']) ||
    value.result_info.page !== 1 || value.result_info.total_pages !== 1 ||
    !Number.isSafeInteger(value.result_info.per_page) || value.result_info.per_page < value.result.length ||
    value.result_info.count !== value.result.length || value.result_info.total_count !== value.result.length) {
    add('PARTIAL_OR_INVALID_API_ENVELOPE',ref); return [];
   }
   return value.result;
  }
  if (!keys(access,['capturedAt','complete','applications','groups','policies'])) add('UNKNOWN_ACCESS_SNAPSHOT_FIELDS');
  if (!keys(hosts,['capturedAt','complete','workersDev','previewUrls','hosts'])) add('UNKNOWN_HOST_SNAPSHOT_FIELDS');
  for (const snapshot of [d1Before,d1After]) if (!keys(snapshot,['capturedAt','complete','members'])) add('UNKNOWN_D1_SNAPSHOT_FIELDS');
  fresh(access,'access'); fresh(hosts,'hosts'); fresh(d1Before,'d1-before'); fresh(d1After,'d1-after');
  if (!Array.isArray(expectedHosts) || !expectedHosts.length || !expectedHosts.every(host) || new Set(expectedHosts).size !== expectedHosts.length) add('INVALID_EXPECTED_HOSTS');
  if (!Array.isArray(expectedIdps) || !expectedIdps.length || !expectedIdps.every(text) || new Set(expectedIdps).size !== expectedIdps.length) add('INVALID_EXPECTED_IDPS');
  if (hosts?.workersDev !== false || hosts?.previewUrls !== false) add('DIRECT_WORKER_HOST_EXPOSURE','hosts');
  if (!sameSet(hosts?.hosts,expectedHosts) || !hosts?.hosts?.every(host)) add('HOST_INVENTORY_MISMATCH','hosts');
  const apps = envelope(access?.applications,'applications');
  const groups = envelope(access?.groups,'groups');
  const groupMap = new Map(), appIds = new Set(), policyIds = new Set(), groupRefs = new Map();
  const idpRefs = new Map();
  const idpRef = id => {
   if (!text(id)) return 'invalid-idp';
   if (!idpRefs.has(id)) idpRefs.set(id,`idp-${idpRefs.size+1}`);
   return idpRefs.get(id);
  };
  if (Array.isArray(expectedIdps)) expectedIdps.forEach(idpRef);
  const candidates = [];
  let ruleBudget = 10000;
  groups.forEach((g,i) => {
   const ref = `group-${i+1}`;
   if (!object(g) || !text(g.id) || groupMap.has(g.id)) { add('INVALID_OR_DUPLICATE_GROUP',ref); return; }
   inventory.push({ref,kind:'group'});
   groupMap.set(g.id,g); groupRefs.set(g.id,ref);
  });
  function rules(entity, ref, stack = [], collect = false) {
   const emails = [];
   if (!object(entity)) { add('MALFORMED_RULE_CONTAINER',ref); return emails; }
   for (const lane of ['include','require','exclude']) {
    if (!Array.isArray(entity[lane]) || (lane === 'include' && !entity[lane].length)) { add('MISSING_RULE_ARRAY',ref); continue; }
    entity[lane].forEach((rule,i) => {
     if (--ruleBudget < 0) { if (ruleBudget === -1) add('RULE_BUDGET_EXCEEDED'); return; }
     const location = `${ref}/${lane}-${i+1}`;
     const selector = object(rule) && Object.keys(rule).length === 1 ? Object.keys(rule)[0] : '';
     const kind = ['email','group','login_method','everyone','email_domain','service_token','any_valid_service_token'].includes(selector) ? selector : 'unsupported';
     const visit = {ref:location, lane, selector:kind};
     if (selector === 'login_method') visit.identityProviderRef = idpRef(rule[selector]?.id);
     inventory.push(visit);
     const value = rule?.[selector];
     if (selector === 'email' && keys(value,['email']) && Object.keys(value).length === 1) {
      try {
       const email = normalizeEmail(value.email);
       if (email.includes('*')) throw Error();
       if (lane === 'include' && collect) emails.push(email);
       if (lane !== 'include') add('CONSTRAINED_CONTACT_SET_UNSUPPORTED',location);
      } catch { add('INVALID_EMAIL_SELECTOR',location); }
     } else if (selector === 'group' && keys(value,['id']) && text(value.id)) {
      const group = groupMap.get(value.id);
      if (!group) add('MISSING_GROUP_REFERENCE',location);
      else if (stack.includes(value.id) || stack.length >= 16) add('CYCLIC_OR_DEEP_GROUP',location);
      else {
       // Nested groups are inventoried but deliberately unsupported.
       if (stack.length || lane !== 'include') add('NESTED_OR_CONSTRAINED_GROUP_UNSUPPORTED',location);
       const nested = rules(group,groupRefs.get(value.id),[...stack,value.id],collect && lane === 'include');
       if (lane === 'include') emails.push(...nested);
      }
     } else if (selector === 'login_method' && keys(value,['id']) && text(value.id)) {
      if (lane !== 'require' || !expectedIdps?.includes(value.id) || stack.length) add('UNSCOPED_LOGIN_METHOD',location);
     } else add(kind === 'unsupported' ? 'UNSUPPORTED_SELECTOR' : 'UNSAFE_SELECTOR',location);
    });
   }
   return emails;
  }
  // Inventory even unreferenced groups, so hidden unsupported content is visible.
  for (const [id,g] of groupMap) {
   if (!keys(g,['id','name','include','require','exclude'])) add('UNKNOWN_GROUP_FIELDS',groupRefs.get(id));
   rules(g,groupRefs.get(id),[id]);
  }
  if (!Array.isArray(access?.policies)) { add('MISSING_POLICY_INVENTORY'); return; }
  const records = new Map();
  access.policies.forEach((record,i) => {
   if (!keys(record,['applicationId','response']) || !text(record.applicationId) || records.has(record.applicationId)) add('INVALID_OR_DUPLICATE_POLICY_INVENTORY',`policy-list-${i+1}`);
   else records.set(record.applicationId,record.response);
  });
  const coveredHosts = new Set();
  apps.forEach((app,i) => {
   const ref = `app-${i+1}`;
   inventory.push({ref,kind:'application',hostRef:Array.isArray(expectedHosts) && expectedHosts.includes(app?.domain) ? `host-${expectedHosts.indexOf(app.domain)+1}` : 'unknown-host',
    identityProviderRefs:Array.isArray(app?.allowed_idps) ? app.allowed_idps.map(idpRef) : []});
   if (!keys(app,['id','name','type','domain','allowed_idps','auto_redirect_to_identity'])) add('UNKNOWN_APPLICATION_FIELDS',ref);
   if (!text(app?.id) || appIds.has(app.id)) add('INVALID_OR_DUPLICATE_APPLICATION',ref);
   appIds.add(app?.id);
   if (app?.type !== 'self_hosted' || !host(app?.domain) || !expectedHosts?.includes(app.domain) || app.domain.endsWith('.workers.dev')) add('HOST_OR_APPLICATION_VARIANT_UNSUPPORTED',ref);
   else if (coveredHosts.has(app.domain)) add('OVERLAPPING_APPLICATIONS',ref);
   else coveredHosts.add(app.domain);
   if (!sameSet(app?.allowed_idps,expectedIdps)) add('UNSCOPED_APPLICATION_IDPS',ref);
   if (!records.has(app?.id)) { add('MISSING_APPLICATION_POLICIES',ref); return; }
   const policies = envelope(records.get(app.id),ref);
   if (!policies.length) add('EMPTY_POLICY_SET',ref);
   const precedences = new Set();
   policies.forEach((policy,p) => {
    const pr = `${ref}/policy-${p+1}`;
    if (!keys(policy,['id','name','decision','precedence','include','require','exclude'])) add('UNKNOWN_POLICY_FIELDS',pr);
    if (!text(policy?.id) || policyIds.has(policy.id)) add('INVALID_OR_DUPLICATE_POLICY',pr);
    policyIds.add(policy?.id);
    const decision = ['allow','deny','bypass','non_identity'].includes(policy?.decision) ? policy.decision : 'unknown';
    inventory.push({ref:pr,decision});
    if (!Number.isSafeInteger(policy?.precedence) || policy.precedence < 0 || precedences.has(policy.precedence)) add('AMBIGUOUS_PRECEDENCE',pr);
    precedences.add(policy?.precedence);
    // Do not approximate deny/bypass precedence or claim effective user sets.
    if (decision !== 'allow') add('NON_ALLOW_DECISION_UNSUPPORTED',pr);
    const contacts = rules(policy,pr,[],decision === 'allow');
    const req = policy?.require;
    if (!Array.isArray(req) || req.length !== 1 || !object(req[0]?.login_method) || Object.keys(req[0]).length !== 1) add('LOGIN_METHOD_SCOPE_REQUIRED',pr);
    if (policy?.exclude?.length) add('EXCLUSION_SEMANTICS_UNSUPPORTED',pr);
    for (const email of contacts) candidates.push({email,app:ref});
   });
  });
  for (const id of records.keys()) if (!appIds.has(id)) add('ORPHAN_POLICY_INVENTORY');
  if (!sameSet([...coveredHosts],expectedHosts)) add('MISSING_HOST_APPLICATION');
  const before = d1Rows(d1Before,'d1-before');
  d1Rows(d1After,'d1-after');
  // Exact repeat-read comparison is intentionally conservative, including order.
  if (JSON.stringify(d1Before?.members) !== JSON.stringify(d1After?.members) || d1After?.capturedAt < d1Before?.capturedAt) add('D1_READBACK_DRIFT');
  const desired = new Map(), known = new Map();
  const foldedContacts = new Set();
  for (const row of before) {
   if (foldedContacts.has(row.recipient.toLowerCase())) add('DUPLICATE_D1_CONTACT');
   foldedContacts.add(row.recipient.toLowerCase());
   const ref = `member-${known.size+1}`;
   if (known.has(row.recipient)) add('DUPLICATE_D1_CONTACT',ref);
   known.set(row.recipient,ref);
   if (row.status === 'active' || (row.status === 'pending' && ['blocked','projected','delivered'].includes(row.invitationStatus) && row.expiresAt > now)) desired.set(row.recipient,ref);
  }
  // Per-host union of explicit email selectors only; these are contact candidates,
  // never actual users, provider subjects, sessions, or app authorization results.
  for (let i=0;i<apps.length;i++) {
   const app = `app-${i+1}`, seen = new Set();
   for (const [n,c] of candidates.entries()) if (c.app === app) {
    const ref = known.get(c.email) || `candidate-${n+1}`;
    if (seen.has(c.email)) differences.push({kind:'duplicate',ref,app});
    seen.add(c.email);
    if (!desired.has(c.email)) differences.push({kind:'extra-or-ineligible',ref,app});
   }
   for (const [email,ref] of desired) if (!seen.has(email)) differences.push({kind:'missing',ref,app});
  }
  function d1Rows(snapshot, ref) {
   if (!Array.isArray(snapshot?.members)) { add('MISSING_D1_ROWS',ref); return []; }
   const ids = new Set(), rows = [];
   snapshot.members.forEach((row,i) => {
    const rr = `${ref}/row-${i+1}`;
    if (!keys(row,['id','recipient','status','invitationId','invitationStatus','expiresAt']) || !text(row.id) || ids.has(row.id) || !['active','pending','revoked'].includes(row.status)) { add('INVALID_OR_DUPLICATE_D1_ROW',rr); return; }
    ids.add(row.id);
    try { if (normalizeEmail(row.recipient) !== row.recipient) throw Error(); }
    catch { add('INVALID_D1_CONTACT',rr); return; }
    const hasInvite = row.invitationId !== null || row.invitationStatus !== null || row.expiresAt !== null;
    if (hasInvite && (!text(row.invitationId) || !['blocked','projected','delivered','claimed','expired','revoked','superseded'].includes(row.invitationStatus) || !time(row.expiresAt))) add('INVALID_D1_INVITATION',rr);
    rows.push(row);
   });
   return rows;
  }
 }
}
