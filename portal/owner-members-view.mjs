import {studioPage,escapeHtml} from './studio-ui.mjs';

// Task #11 membership requests remain in their existing protected Launchpad.
// Without an action token this remains the original read-only Owner directory.
export async function ownerMembersView(db,mountPath='/app',actionToken=null) {
 const members=(await db.prepare("SELECT m.id,m.recipient,m.role,m.status,i.id AS invite_id,i.status AS invite_status,i.expires_at AS invite_expires_at,(SELECT COUNT(*) FROM service_grants g WHERE g.member_id=m.id) AS grants FROM members m LEFT JOIN invitations i ON i.id=(SELECT id FROM invitations WHERE member_id=m.id ORDER BY revision DESC LIMIT 1) ORDER BY m.created_at DESC,m.id LIMIT 101").all()).results;
 const audits=(await db.prepare("SELECT a.action,a.at,m.recipient FROM audit_events a JOIN members m ON m.id=a.member_id ORDER BY a.at DESC,a.id DESC LIMIT 61").all()).results;
 if(!Array.isArray(members)||!Array.isArray(audits))throw Error('unavailable private directory');
 const memberMore=members.length>100,auditMore=audits.length>60;
 const visibleMembers=members.slice(0,100),visibleAudits=audits.slice(0,60);
 const e=escapeHtml,prefix=mountPath==='/app'?'/app':'';
 const enabled=typeof actionToken==='string' && /^[A-Za-z0-9_-]{43}$/.test(actionToken);
 const form=(action,fields,label)=>enabled?
  '<form method="post" action="'+prefix+'/manage"><input type="hidden" name="csrf" value="'+e(actionToken)+'"><input type="hidden" name="action" value="'+e(action)+'">'+fields+'<button type="submit">'+e(label)+'</button></form>':'';
 const records=visibleMembers.map(row=>{
  if(!['owner','trusted','member'].includes(row.role)||!['pending','active','revoked'].includes(row.status))throw Error('invalid member');
  const fields='<input type="hidden" name="member" value="'+e(row.id)+'">';
  let actions='';
  if(row.role!=='owner' && row.status==='pending'){
   actions+=form(row.invite_id?'reissue':'issue',fields,row.invite_id?'Reissue draft invitation':'Create draft invitation');
   if(row.invite_id&&['blocked','projected','delivered'].includes(row.invite_status))
    actions+=form('cancel','<input type="hidden" name="member" value="'+e(row.invite_id)+'">','Cancel invitation');
  }
  return '<li class="tile"><strong>'+e(row.recipient)+'</strong><p>Role: '+e(row.role)+' · Status: '+e(row.status)+' · Invite: '+e(row.invite_status||'None')+' · Service grants: '+e(row.grants)+'</p>'+actions+'</li>';
 }).join('');
 const events=visibleAudits.map(row=>'<li class="tile"><strong>'+e(row.action)+'</strong><p>'+e(row.recipient)+' · '+e(new Date(row.at*1000).toISOString())+'</p></li>').join('');
 const create=enabled?'<section class="panel wide"><h2>Add an approved recipient</h2><p class="muted">Enter an email only after you have reviewed the person. This creates a pending D1 record, not a login or an invitation.</p>'+
  form('create','<label>Approved email <input type="email" name="contact" autocomplete="off" maxlength="254" required></label>','Create pending member')+'</section>':'';
 return studioPage('Manage your studio',
  '<p class="lede">A private view of your studio members and recent activity.</p><div class="grid">'+
  '<section class="panel wide"><h2>Membership requests</h2><p class="muted">Membership requests are reviewed from the existing protected Owner Launchpad. Approving a public request does not automatically create a member.</p><a class="button" href="https://owner.bigsoxstudios.com/membership/requests/">Review membership requests</a></section>'+
  create+
  '<section class="panel wide"><h2>Members and invitations</h2><p class="muted">'+(enabled?'Draft invitations are stored securely and audited but cannot be claimed or delivered until the separately approved Task 12.2 invitation flow. No automatic sending.':'Invitations and invite claims are coming next. This list is read-only.')+'</p>'+(memberMore?'<p class="muted">Showing the latest 100 members.</p>':'')+(records?'<ul style="list-style:none;padding:0">'+records+'</ul>':'<p>No members yet.</p>')+'</section>'+
  '<section class="panel wide"><h2>Recent activity</h2>'+(auditMore?'<p class="muted">Showing the latest 60 events.</p>':'')+(events?'<ul style="list-style:none;padding:0">'+events+'</ul>':'<p class="muted">No recent activity.</p>')+'</section></div>'+
  '<p><a class="button secondary" href="'+prefix+'/">Back to dashboard</a></p>','Owner workspace');
}
