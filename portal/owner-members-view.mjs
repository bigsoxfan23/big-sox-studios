import {studioPage,escapeHtml} from './studio-ui.mjs';

// Read-only on existing D1. Task #11 public requests remain in Owner Launchpad.
export async function ownerMembersView(db,mountPath='/app') {
 const members=(await db.prepare("SELECT m.recipient,m.role,m.status,(SELECT i.status FROM invitations i WHERE i.member_id=m.id ORDER BY i.revision DESC LIMIT 1) AS invite_status,(SELECT COUNT(*) FROM service_grants g WHERE g.member_id=m.id) AS grants FROM members m ORDER BY m.created_at DESC,m.id LIMIT 101").all()).results;
 const audits=(await db.prepare("SELECT a.action,a.at,m.recipient FROM audit_events a JOIN members m ON m.id=a.member_id ORDER BY a.at DESC,a.id DESC LIMIT 61").all()).results;
 if(!Array.isArray(members)||!Array.isArray(audits))throw Error('unavailable private directory');
 const memberMore=members.length>100,auditMore=audits.length>60;
 const visibleMembers=members.slice(0,100),visibleAudits=audits.slice(0,60);
 const e=escapeHtml;
 const records=visibleMembers.map(row=>{
  if(!['owner','trusted','member'].includes(row.role)||!['pending','active','revoked'].includes(row.status))throw Error('invalid member');
  return '<li class="tile"><strong>'+e(row.recipient)+'</strong><p>Role: '+e(row.role)+' · Status: '+e(row.status)+' · Invite: '+e(row.invite_status||'None')+' · Service grants: '+e(row.grants)+'</p></li>';
 }).join('');
 const events=visibleAudits.map(row=>'<li class="tile"><strong>'+e(row.action)+'</strong><p>'+e(row.recipient)+'</p></li>').join('');
 const prefix=mountPath==='/app'?'/app':'';
 return studioPage('Manage your studio',
  '<p class="lede">A private view of your studio members and recent activity.</p><div class="grid">'+
  '<section class="panel wide"><h2>Membership requests</h2><p class="muted">Membership requests are reviewed from the existing protected Owner Launchpad. Approving a public request does not automatically create a member.</p><a class="button" href="https://owner.bigsoxstudios.com/membership/requests/">Review membership requests</a></section>'+
  '<section class="panel wide"><h2>Members and invitations</h2><p class="muted">Invitations and invite claims are coming next. This list is read-only.</p>'+(memberMore?'<p class="muted">Showing the latest 100 members.</p>':'')+(records?'<ul style="list-style:none;padding:0">'+records+'</ul>':'<p>No members yet.</p>')+'</section>'+
  '<section class="panel wide"><h2>Recent activity</h2>'+(auditMore?'<p class="muted">Showing the latest 60 events.</p>':'')+(events?'<ul style="list-style:none;padding:0">'+events+'</ul>':'<p class="muted">No recent activity.</p>')+'</section></div>'+
  '<p><a class="button secondary" href="'+prefix+'/">Back to dashboard</a></p>','Owner workspace');
}
