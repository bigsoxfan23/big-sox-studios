const $ = id => document.getElementById(id);
let csrf, current, reviewed, busy = false;
const say = text => { $('status').textContent = text; };
async function api(path, data) {
 const response = await fetch(path, { credentials:'same-origin', cache:'no-store', ...(data === undefined ? {} : { method:'POST', headers:{ 'Content-Type':'application/json', 'X-CSRF-Token':csrf }, body:JSON.stringify(data) }) });
 const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed'); return value;
}
function node(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
async function queue() {
 const cases = await api('/api/cases'); $('queue').replaceChildren();
 for (const c of cases) {
  const button = node('button', c.subject, 'queue-item'); button.type = 'button'; button.setAttribute('aria-current', String(c.id === current?.id));
  button.append(node('small', `${c.channel}@ · ${c.requester_name}`));
  button.onclick = () => act(() => openCase(c.id)); $('queue').append(button);
 }
 if (!cases.length) $('queue').append(node('p','No synthetic cases yet.','muted'));
}
async function openCase(id) {
 current = await api(`/api/cases/${id}`); reviewed = null;
 $('detail').replaceChildren($('case-template').content.cloneNode(true));
 $('subject').textContent = current.subject;
 $('identity').textContent = `${current.requester_name} · ${current.requester_email} · ${current.channel}@bigsoxstudios.com`;
 for (const message of current.messages) {
  const block = node('article','','message'); block.append(node('small',message.direction === 'inbound' ? 'Received' : 'Mock reply'), node('p',message.body)); $('thread').append(block);
 }
 for (const delivery of current.deliveries) $('deliveries').append(node('p',`Revision ${delivery.revision} · ${delivery.status}`));
 const locked = current.deliveries.some(d => ['UNKNOWN','dispatching'].includes(d.status));
 $('draft').value = current.draft; $('draft').disabled = locked; $('review').disabled = locked;
 if (locked) say('Delivery requires owner reconciliation. Sending is locked.');
 $('draft').oninput = () => { reviewed = null; $('approval').hidden = true; };
 $('review').onclick = () => act(async () => {
  current = { ...current, ...await api(`/api/cases/${id}/draft`, { revision:current.revision, body:$('draft').value }) };
  reviewed = await api(`/api/cases/${id}/review`, { revision:current.revision });
  $('envelope').textContent = `To: ${reviewed.to}\nFrom: ${reviewed.from}\nSubject: ${reviewed.subject}`;
  $('preview').textContent = reviewed.body; $('approval').hidden = false; $('draft').disabled = true; $('review').disabled = true;
 });
 $('cancel').onclick = () => { reviewed = null; $('approval').hidden = true; $('draft').disabled = false; $('review').disabled = false; };
 $('send').onclick = () => act(async () => {
  if (!reviewed) return;
  const delivery = await api(`/api/cases/${id}/send`, { intentId:reviewed.id, approval:reviewed.approval });
  reviewed = null; await openCase(id); say(`Delivery: ${delivery.status}.`); await queue();
 });
}
async function act(fn) {
 if (busy) return; busy = true; document.body.setAttribute('aria-busy','true');
 try { await fn(); } catch (error) { say(`Unable to complete: ${error.message}. Refresh before trying again.`); }
 finally { busy = false; document.body.removeAttribute('aria-busy'); }
}
$('refresh').onclick = () => act(queue);
await act(async () => { const session = await api('/api/session'); csrf = session.csrf; await queue(); say('Private staging ready. Mock delivery only.'); });
