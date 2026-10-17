/* Capabilities and immutable snapshots live only in this page's memory. */
(() => {
 'use strict';
 const el = id => document.getElementById(id);
 const buttons = ['preview', 'review', 'approve', 'dispatch'];
 let stage = 'loading', token, payload, expires = 0, authority = false, busy = false, attempted = false;
 let applicationStepup = false;
 const labels = {
  accepted: 'Provider accepted · Delivered not yet verified',
  refused: 'Rejected by provider · No retry permitted',
  UNKNOWN: 'UNKNOWN · May have been sent. Do not retry.',
  submitted: 'UNKNOWN · Submission recorded. Do not retry.'
 };
 function render(message, detail = '') {
  el('status').textContent = message;
  el('detail').textContent = detail;
  for (const id of buttons) el(id).disabled = busy || attempted || !authority ||
   stage !== ({ preview: 'empty', review: 'previewed', approve: 'reviewed', dispatch: 'approved' }[id]);
 }
 function halt(message) {
  stage = 'halted'; token = undefined;
  el('confirmation').close();
  render(message, 'Halted. Do not create another campaign or retry. Retain the permanent ledger for operator review.');
 }
 function fresh() {
  if (expires && Date.now() >= expires * 1000) { halt('Preview expired · Security blocked'); return false; }
  return true;
 }
 async function request(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
   cache: 'no-store', redirect: 'error', headers: body === undefined ? {} : {
    'Content-Type': 'application/json', 'X-Canary-Action': path.slice(1)
   }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // Never display server exception strings or response HTML.
  const data = await response.json();
  if (!response.ok) throw new Error('blocked');
  return data;
 }
 function showSnapshot(value) {
  payload = Object.freeze({ from: value.from, to: value.to, subject: value.subject, text: value.text });
  for (const field of ['from', 'to', 'subject', 'text']) {
   if (typeof payload[field] !== 'string') throw new Error('blocked');
   el(field).textContent = payload[field];
   el(`confirm-${field}`).textContent = payload[field];
  }
  el('snapshot').hidden = false;
 }
 async function stepupProof(purpose) {
  await request('/stepup/session', {});
  const options = await request('/stepup/challenge', { purpose });
  const bytes = s => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const publicKey = options.publicKey;
  publicKey.challenge = bytes(publicKey.challenge);
  publicKey.allowCredentials = publicKey.allowCredentials.map(c => ({ ...c, id: bytes(c.id) }));
  const c = await navigator.credentials.get({ publicKey });
  const response = { clientDataJSON: b64(c.response.clientDataJSON), authenticatorData: b64(c.response.authenticatorData), signature: b64(c.response.signature),
   ...(c.response.userHandle ? { userHandle: b64(c.response.userHandle) } : {}) };
  const verified = await request('/stepup/verify', { purpose, id: options.id,
   response: { id: c.id, rawId: b64(c.rawId), type: c.type, response, clientExtensionResults: c.getClientExtensionResults() } });
  return verified.proof;
 }
 async function transition(action) {
  const required = { preview: 'empty', review: 'previewed', approve: 'reviewed' }[action];
  if (busy || attempted || !authority || stage !== required || !fresh()) return;
  busy = true; render('Verifying security gates…');
  try {
   const body = action === 'preview' ? {} : { token };
   if (applicationStepup && action === 'preview') body.proof = await stepupProof('preview');
   const data = await request(`/${action}`, body);
   if (stage !== required) return;
   if (typeof data.token !== 'string' || !Number.isSafeInteger(data.expires)) throw new Error('blocked');
   if (action === 'preview') showSnapshot(data.snapshot.payload);
   token = data.token; expires = data.expires; stage = { preview: 'previewed', review: 'reviewed', approve: 'approved' }[action];
   if (!fresh()) return;
   el('expiry').textContent = `Preview expires: ${new Date(expires * 1000).toISOString()}. Approval does not extend this deadline.`;
   render({ previewed: 'Preview ready · Read the exact message', reviewed: 'Reviewed · Separate approval required', approved: 'Approved · No message sent. Separate confirmation required.' }[stage]);
  } catch { halt('Security blocked · Preview or session unavailable'); }
  finally { busy = false; render(el('status').textContent, el('detail').textContent); }
 }
 for (const action of ['preview', 'review', 'approve']) el(action).addEventListener('click', () => transition(action));
 el('dispatch').addEventListener('click', () => {
  if (!busy && !attempted && authority && stage === 'approved' && fresh()) el('confirmation').showModal();
 });
 el('cancel').addEventListener('click', () => el('confirmation').close());
 el('send').addEventListener('click', async () => {
  if (!el('confirmation').open || busy || attempted || !authority || stage !== 'approved' || !fresh()) return;
  // Lock before any network I/O, including failed requests. Never offer retry.
  attempted = true; busy = true; el('send').disabled = true; el('confirmation').close();
  render('Submission attempted · Do not retry');
  const approvedToken = token; token = undefined;
  try {
   const body = { token: approvedToken };
   if (applicationStepup) body.proof = await stepupProof('dispatch');
   const data = await request('/dispatch', body);
   stage = 'halted'; render(labels[data.status] ?? labels.UNKNOWN, 'Delivery remains unverified. No retry or second campaign.');
  } catch { halt(labels.UNKNOWN); }
  finally { busy = false; }
 });
 // A resumed page must not silently resume an intention or restore capabilities.
 window.addEventListener('pagehide', () => { token = undefined; payload = undefined; stage = 'halted'; });
 window.addEventListener('pageshow', event => { if (event.persisted) halt('Session resumed · Security blocked'); });
 setInterval(() => { if (['previewed', 'reviewed', 'approved'].includes(stage)) fresh(); }, 1000);
 request('/status').then(data => {
  if (stage !== 'loading') return;
  authority = data.sendAuthority === true;
  applicationStepup = data.applicationStepup === true;
  stage = data.status === 'empty' ? 'empty' : 'halted';
  if (!authority) render('Disabled · Security blocked', 'The release gate is closed. No preview or send is available.');
  else if (stage === 'empty') render('Ready for one immutable preview', 'Creating a preview permanently consumes the single campaign slot, even if it expires.');
  else render(labels[data.status] ?? 'Existing campaign · Halted', 'This page cannot recover a capability or start another campaign. No retry.');
 }).catch(() => halt('Disabled · Security blocked'));
})();
