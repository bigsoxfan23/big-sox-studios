// Request -> pending Member bridge. Caller must supply verified Owner context and
// existing, server-owned D1 handles. Never accepts a request snapshot from a form.
// No email, identity binding, membership activation or Jellyfin API calls here.
import {normalizeEmail} from './identity.mjs';
const deny = () => { throw Error('Onboarding unavailable. Reload the approved request.'); };
const id = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const safeTime = n => Number.isSafeInteger(n) && n>=0;
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
export function createRequestOnboarding({requestDb,memberDb,sourceDatabase,actorId,expiresAt,jellyfinOrigin,now=()=>Math.floor(Date.now()/1000)}={}) {
 if(!requestDb?.prepare || !memberDb?.prepare || !memberDb?.batch || !id(sourceDatabase) || !id(actorId) || !safeTime(expiresAt)) deny();
 const query=(sql,...args)=>memberDb.prepare(sql).bind(...args);
 async function approved(requestId,expectedRevision) {
  if(!id(requestId) || !Number.isSafeInteger(expectedRevision) || expectedRevision<1) deny();
  const at=now(); if(!safeTime(at) || at>=expiresAt) deny();
  if(!await query("SELECT id FROM members WHERE id=? AND role='owner' AND status='active'",actorId).first()) deny();
  const row=await requestDb.prepare('SELECT id,email,status,revision,pii_cleared_at FROM membership_requests WHERE id=?').bind(requestId).first();
  if(!row || row.status!=='approved' || row.revision!==expectedRevision || row.pii_cleared_at!==null) deny();
  const recipient=normalizeEmail(row.email); return {...row,recipient};
 }
 async function linked(requestId,revision) {
  const request=await approved(requestId,revision);
  const row=await query(`SELECT o.*,m.recipient,m.role,m.status FROM member_onboarding o
   JOIN members m ON m.id=o.member_id WHERE o.source_database=? AND o.request_id=?`,sourceDatabase,requestId).first();
  if(!row || row.request_revision>revision || row.recipient!==request.recipient || row.role!=='member' || row.status!=='pending') deny();
  return row;
 }
 return {
  async link(requestId,revision) {
   const request=await approved(requestId,revision);
   const existing=await query('SELECT member_id FROM member_onboarding WHERE source_database=? AND request_id=?',sourceDatabase,requestId).first();
   if(existing) return linked(requestId,revision);
   // A contact collision is only a candidate, never permission to reuse it.
   // Recheck every reuse condition in the atomic onboarding INSERT below.
   const contact=await query('SELECT id FROM members WHERE lower(recipient)=lower(?)',request.recipient).first();
   const memberId=contact?.id ?? 'request_'+(await digest(JSON.stringify([sourceDatabase,requestId]))).slice(0,40);
   if((await approved(requestId,revision)).recipient!==request.recipient) deny();
   const at=now();
   if(!safeTime(at) || at>=expiresAt) deny();
   const results=await memberDb.batch([
    query(`INSERT INTO members(id,recipient,role,status,created_at)
     SELECT ?,?,'member','pending',? WHERE EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active')
     AND unixepoch('now')<? AND ?=0 ON CONFLICT(id) DO NOTHING`,memberId,request.recipient,at,actorId,expiresAt,Number(!!contact)),
    query(`INSERT INTO member_onboarding(source_database,request_id,request_revision,member_id,actor_id,approved_at)
     SELECT ?,?,?,(SELECT m.id FROM members m WHERE m.id=? AND m.recipient=? AND m.role='member' AND m.status='pending'
     AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active') AND unixepoch('now')<?
     AND (?=0 OR (
      EXISTS(SELECT 1 FROM invitations i WHERE i.member_id=m.id AND i.recipient=m.recipient AND i.issuer_id=?
       AND i.status='delivered' AND i.expires_at>unixepoch('now') AND i.expires_at>?
       AND i.claimed_at IS NULL AND i.claim_provider IS NULL AND i.claim_subject IS NULL)
      AND NOT EXISTS(SELECT 1 FROM identities WHERE member_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM service_grants WHERE member_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM revocations WHERE member_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM revocation_tasks WHERE member_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM member_onboarding WHERE member_id=m.id)
     ))),?,?
     WHERE NOT EXISTS(SELECT 1 FROM member_onboarding WHERE source_database=? AND request_id=?)
     ON CONFLICT(source_database,request_id) DO NOTHING`,sourceDatabase,requestId,revision,memberId,request.recipient,actorId,expiresAt,Number(!!contact),actorId,at,actorId,at,sourceDatabase,requestId),
    // Once the existing pending Member is linked to the approved request, retire
    // its legacy claim code in the SAME D1 transaction. Preserve the invitation
    // and its immutable audit history; never leave another admission route live.
    ...(contact ? [query(`UPDATE invitations SET status='superseded',digest=NULL,changed_at=?,actor_id=?
     WHERE member_id=? AND issuer_id=? AND recipient=? AND status='delivered'
     AND expires_at>unixepoch('now') AND EXISTS(SELECT 1 FROM member_onboarding
      WHERE source_database=? AND request_id=? AND member_id=? AND request_revision=?)`,
     at,actorId,memberId,actorId,request.recipient,sourceDatabase,requestId,memberId,revision)] : [])
   ]);
   // The concurrent retry may observe the first transaction's complete link and
   // retired invitation; that is safe idempotence, not a second adoption.
   if(contact && results[2]?.meta?.changes!==1){
    const row=await linked(requestId,revision);
    if(row.member_id!==memberId || await query("SELECT id FROM invitations WHERE member_id=? AND status='delivered'",memberId).first()) deny();
    return row;
   }
   // Cross-DB operations are not atomic. A withdrawn/revised request fails this
   // fresh read. Its pending row grants no access and is never activated here.
   return linked(requestId,revision);
  },
  read: linked,
  async markJellyfinReady(requestId,requestRevision,{expectedRevision,confirmed,username,url}={}) {
   const current=await linked(requestId,requestRevision);
   if(confirmed!==true || !Number.isSafeInteger(expectedRevision) || current.revision!==expectedRevision || current.jellyfin_ready_at!==null) deny();
   if(typeof username!=='string' || username!==username.trim() || username.length<1 || username.length>128 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(username)) deny();
   let parsed,origin;try{parsed=new URL(url);origin=new URL(jellyfinOrigin);}catch{deny();}
   if(origin.protocol!=='https:' || origin.origin!==jellyfinOrigin || parsed.protocol!=='https:' || parsed.origin!==jellyfinOrigin || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.href!==url) deny();
   const at=now(); if(!safeTime(at) || at>=expiresAt) deny();
   const result=await query(`UPDATE member_onboarding SET jellyfin_ready_at=?,jellyfin_username=?,jellyfin_url=?,revision=revision+1
    WHERE source_database=? AND request_id=? AND revision=? AND jellyfin_ready_at IS NULL
    AND EXISTS(SELECT 1 FROM members WHERE id=member_onboarding.member_id AND role='member' AND status='pending')
    AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active') AND unixepoch('now')<? RETURNING member_id`,at,username,url,sourceDatabase,requestId,expectedRevision,actorId,expiresAt).first();
   if(!result) deny(); return linked(requestId,requestRevision);
  }
 };
}
