export const enrollmentAssets = {
 '/': { type: 'text/html; charset=utf-8', body: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Owner passkey enrollment only</title><script src="/enroll.js" defer></script><h1>Owner passkey enrollment only</h1><p>Use native Safari directly on the exact reviewed canary hostname, on your own device. Do not use a remote browser. This ceremony creates an UNTRUSTED public candidate. It cannot authorize email or pin a key.</p><button id="create">Create passkey</button><button id="prove" disabled>Prove possession</button><pre id="result" aria-live="polite"></pre><p>After proof succeeds, compare the full fingerprint and public record. Confirm that exact full fingerprint in the established owner chat. A later, separately reviewed code change must pin those exact bytes. Fingerprint confirmation is NOT email send confirmation. Sending still requires exact final From, To, Subject and body review, a separate explicit chat confirmation, and fresh preview and dispatch ceremonies.</p></html>` },
 '/enroll.js': { type: 'text/javascript; charset=utf-8', body: String.raw`
const output = document.querySelector('#result');
const create = document.querySelector('#create');
const prove = document.querySelector('#prove');
let candidate;
const bytes = s => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
async function post(path, body) {
 const r = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: {
  'Content-Type': 'application/json', 'X-Canary-Action': path.slice(1)
 }, body: JSON.stringify(body) });
 if (!r.ok) throw new Error('Ceremony unavailable. No authority granted.');
 return r.json();
}
function serialize(c) {
 const response = { clientDataJSON: b64(c.response.clientDataJSON) };
 for (const k of ['attestationObject','authenticatorData','signature','userHandle']) {
  if (c.response[k]) response[k] = b64(c.response[k]);
 }
 return { id: c.id, rawId: b64(c.rawId), type: c.type, response, clientExtensionResults: c.getClientExtensionResults() };
}
create.onclick = async () => {
 create.disabled = true; prove.disabled = true; candidate = undefined;
 try {
  await post('/stepup/session', {});
  const options = await post('/enroll/register/options', {});
  const publicKey = options.publicKey;
  publicKey.challenge = bytes(publicKey.challenge); publicKey.user.id = bytes(publicKey.user.id);
  const credential = await navigator.credentials.create({ publicKey });
  candidate = (await post('/enroll/register/verify', { id: options.id, response: serialize(credential) })).candidateHandle;
  prove.disabled = false; output.textContent = 'Passkey created as an untrusted candidate. Click Prove possession. No fingerprint is confirmed and no email is authorized.';
 } catch (e) { output.textContent = e.message; } finally { create.disabled = false; }
};
prove.onclick = async () => {
 prove.disabled = true; create.disabled = true;
 try {
  const options = await post('/enroll/prove/options', { candidate });
  const publicKey = options.publicKey;
  publicKey.challenge = bytes(publicKey.challenge);
  publicKey.allowCredentials = publicKey.allowCredentials.map(c => ({ ...c, id: bytes(c.id) }));
  const credential = await navigator.credentials.get({ publicKey });
  const result = await post('/enroll/prove/verify', { candidate, id: options.id, response: serialize(credential) });
  output.textContent = JSON.stringify(result, null, 2);
 } catch (e) { output.textContent = e.message; } finally { create.disabled = false; }
};
` }
};
