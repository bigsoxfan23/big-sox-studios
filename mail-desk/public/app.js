const $ = id => document.getElementById(id);
let csrf, current, reviewed, sendMode = 'pending', busy = false;
const stateText = (status, mode) => ({ reserved:'ready', sent: mode === 'live' ? 'accepted by provider (not delivery confirmation)' : 'simulated send (no email sent)', failed:'refused/no send', UNKNOWN:'unknown outcome (never retry)', dispatching:'unknown outcome (never retry)' })[status] || 'unknown outcome (never retry)';
const say = text => { $('status').textContent = text; };
async function api(path, data) {
 const response = await fetch(path, { credentials:'same-origin', cache:'no-store', ...(data === undefined ? {} : { method:'POST', headers:{ 'Content-Type':'application/json', 'X-CSRF-Token':csrf }, body:JSON.stringify(data) }) });
 const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed'); return value;
}
function node(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
async function queue() {
 const cases = await api('/api/cases'); $('queue').replaceChildren();
 for (const c of cases) {
  const button = node('button', c.displaySubject || c.subject, 'queue-item'); button.type = 'button'; button.setAttribute('aria-current', String(c.id === current?.id));
  button.append(node('small', `${c.channel}@ · ${c.requester_name}`));
  button.onclick = () => act(() => openCase(c.id)); $('queue').append(button);
 }
 if (!cases.length) $('queue').append(node('p','No cases yet.','muted'));
}
async function openCase(id) {
 current = await api(`/api/cases/${id}`); reviewed = null;
 $('detail').replaceChildren($('case-template').content.cloneNode(true));
 $('subject').textContent = current.displaySubject || current.subject;
 $('maildesk-layout').setAttribute('data-view','case');
 $('back-inbox').onclick = () => { $('maildesk-layout').setAttribute('data-view','inbox'); $('refresh').focus?.(); if (typeof window !== 'undefined' && window.matchMedia?.('(max-width:799px)')?.matches) window.scrollTo?.({top:0,behavior:'auto'}); };
 if (typeof window !== 'undefined' && window.matchMedia?.('(max-width:799px)')?.matches) { $('back-inbox').focus?.(); window.scrollTo?.({top:0,behavior:'auto'}); }
 $('identity').textContent = `${current.requester_name} · ${current.requester_email} · ${current.channel}@bigsoxstudios.com`;
 for (const message of current.messages) {
  const block = node('article','','message'); block.append(node('small',message.direction === 'inbound' ? 'Received' : message.mode === 'live' ? 'Reply accepted by provider' : 'Simulated reply (no email sent)'), node('p',message.body)); $('thread').append(block);
 }
 for (const delivery of current.deliveries) $('deliveries').append(node('p',`Revision ${delivery.revision} · ${stateText(delivery.status, delivery.mode)}${delivery.stage ? ` · ${delivery.stage}` : ''}`));
 const locked = current.deliveries.some(d => ['UNKNOWN','dispatching'].includes(d.status));
 $('draft').value = current.draft; $('draft').disabled = locked; $('review').disabled = locked || sendMode === 'pending';
 if (locked) say('Delivery requires owner reconciliation. Sending is locked.');
 $('draft').oninput = () => { reviewed = null; $('approval').hidden = true; };
 $('review').onclick = () => act(async () => {
  current = { ...current, ...await api(`/api/cases/${id}/draft`, { revision:current.revision, body:$('draft').value }) };
  reviewed = await api(`/api/cases/${id}/review`, { revision:current.revision });
  $('envelope').textContent = `To: ${reviewed.to}\nFrom: ${reviewed.from}\nSubject: ${reviewed.subject}`;
  $('preview').textContent = reviewed.body; $('send').textContent = reviewed.mode === 'live' ? 'Send reply' : 'Send simulated reply'; $('review-note').textContent = reviewed.mode === 'live' ? `Ready. Confirmation sends this exact reply from support@bigsoxstudios.com. Subject shown exactly as it will be sent. Review expires in 10 minutes.${reviewed.policy === 'owner-reviewed-customers-v1' ? ' Envelope sender can be spoofed; inspect the exact To mailbox before confirming.' : ''}` : 'Ready. Simulation only: no email will be sent. Review expires in 10 minutes.'; say('Reply ready for confirmation.'); $('approval').hidden = false; $('send').disabled = false; $('draft').disabled = true; $('review').disabled = true;
 });
 $('cancel').onclick = () => { reviewed = null; $('approval').hidden = true; $('draft').disabled = false; $('review').disabled = false; };
 $('send').onclick = () => act(async () => {
  if (!reviewed || !window.confirm(reviewed.mode === 'live' ? `Send this exact reviewed reply to ${reviewed.to} now?` : 'Record this simulated reply? No email will be sent.')) return;
  const snapshot = reviewed; reviewed = null; $('send').disabled = true;
  let delivery;
  try {
   delivery = await api(`/api/cases/${id}/send`, { intentId:snapshot.id, approval:snapshot.approval, confirmed:true });
  } catch (error) {
   const refused = /^(?:reply_preflight_rejected|reply_confirmation_required|reply_inbound_required|approval_denied|approval_expired|csrf_denied|origin_denied|unauthorized|rate_limited|revision_or_delivery_conflict|staging_send_disabled|staging_provider_denied)$/.test(error.message);
   say(refused ? `Refused/no send · ${error.message}.` : 'Unknown outcome (never retry). Refresh to check the recorded state.');
   return;
  }
  reviewed = null; await openCase(id); say(`${stateText(delivery.status, delivery.mode)}${delivery.stage ? ` · ${delivery.stage}` : ''}.`); await queue();
 });
}
async function act(fn) {
 if (busy) return; busy = true; document.body.setAttribute('aria-busy','true');
 try { await fn(); } catch (error) { say(`Unable to complete: ${error.message}. Refresh to check state. If the send outcome is unknown, never retry.`); }
 finally { busy = false; document.body.removeAttribute('aria-busy'); }
}
$('refresh').onclick = () => act(queue);
await act(async () => { const session = await api('/api/session'); csrf = session.csrf; sendMode = session.sendMode; $('mode-notice').textContent = sendMode === 'live' ? (session.replyPolicy === 'owner-reviewed-customers-v1' ? 'Real customer replies · support@bigsoxstudios.com → exact forwarded requester. Envelope sender can be spoofed; inspect the exact To mailbox. Provider acceptance does not confirm delivery.' : 'Real sending · support@bigsoxstudios.com → owner Gmail only. Provider acceptance does not confirm delivery.') : sendMode === 'mock' ? 'Simulated sending · Inbox can contain genuine inbound mail. Send records a simulation; no email is sent.' : 'Sending pending activation · Inbox and drafts remain available. Real sending is disabled.'; await queue(); say(sendMode === 'pending' ? 'Sending pending activation.' : 'Mail Desk ready.'); });
