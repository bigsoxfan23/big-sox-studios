-- Task #12 isolated OFFLINE schema. Never run against Task #11/production D1.
PRAGMA foreign_keys = ON;
CREATE TABLE members (
 id TEXT PRIMARY KEY,
 recipient TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL CHECK(role IN ('owner','trusted','member')),
 status TEXT NOT NULL CHECK(status IN ('pending','active','revoked')),
 created_at INTEGER NOT NULL,
 CHECK(length(recipient) BETWEEN 3 AND 254)
) STRICT;
-- Conservative contact collision guard; never merge identities by case/email.
CREATE UNIQUE INDEX one_contact ON members(lower(recipient));
CREATE TABLE identities (
 provider TEXT NOT NULL CHECK(provider IN ('google','otp','apple')),
 subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 512),
 member_id TEXT NOT NULL REFERENCES members(id),
 bound_at INTEGER NOT NULL,
 PRIMARY KEY(provider,subject),
 UNIQUE(member_id,provider)
) STRICT;
CREATE TRIGGER identity_immutable BEFORE UPDATE ON identities BEGIN SELECT RAISE(ABORT,'immutable binding'); END;
CREATE TRIGGER identity_retained BEFORE DELETE ON identities BEGIN SELECT RAISE(ABORT,'retain binding history'); END;
CREATE TABLE service_grants (
 member_id TEXT NOT NULL REFERENCES members(id),
 service TEXT NOT NULL CHECK(service IN ('jellyfin','palworld','status')),
 PRIMARY KEY(member_id,service)
) STRICT;
CREATE TABLE audit_events (
 id INTEGER PRIMARY KEY,
 actor_id TEXT NOT NULL,
 member_id TEXT NOT NULL REFERENCES members(id),
 artifact_id TEXT,
 action TEXT NOT NULL,
 at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER audit_immutable BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
CREATE TRIGGER audit_retained BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'retain audit'); END;
CREATE TABLE invitations (
 id TEXT PRIMARY KEY,
 member_id TEXT NOT NULL REFERENCES members(id),
 recipient TEXT NOT NULL,
 issuer_id TEXT NOT NULL REFERENCES members(id),
 revision INTEGER NOT NULL CHECK(revision>0),
 predecessor_id TEXT REFERENCES invitations(id),
 digest TEXT UNIQUE CHECK(digest IS NULL OR (length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*')),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at=created_at+604800),
 changed_at INTEGER NOT NULL CHECK(changed_at>=created_at),
 actor_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('blocked','projected','delivered','claimed','expired','superseded','revoked')),
 projection_receipt TEXT,
 projected_at INTEGER,
 delivery_channel TEXT CHECK(delivery_channel IS NULL OR delivery_channel='owner-private-channel'),
 delivered_at INTEGER,
 claim_provider TEXT,
 claim_subject TEXT,
 claimed_at INTEGER,
 UNIQUE(member_id,revision),
 CHECK((status IN ('blocked','projected','delivered') AND digest IS NOT NULL) OR
       (status IN ('claimed','expired','superseded','revoked') AND digest IS NULL)),
 CHECK(status NOT IN ('projected','delivered','claimed') OR (projection_receipt IS NOT NULL AND projected_at IS NOT NULL)),
 CHECK(status!='blocked' OR (projection_receipt IS NULL AND projected_at IS NULL)),
 CHECK(projected_at IS NULL OR projected_at BETWEEN created_at AND changed_at),
 CHECK(delivered_at IS NULL OR (projected_at IS NOT NULL AND delivered_at BETWEEN projected_at AND projected_at+60 AND delivered_at<=changed_at)),
 CHECK(status NOT IN ('delivered','claimed') OR (delivered_at IS NOT NULL AND delivery_channel IS NOT NULL)),
 CHECK(status!='claimed' OR (claim_provider IS NOT NULL AND claim_subject IS NOT NULL AND claimed_at<expires_at))
) STRICT;
-- Includes blocked invites so projection retries cannot bypass the single-live rule.
CREATE UNIQUE INDEX one_live_invite ON invitations(member_id) WHERE status IN ('blocked','projected','delivered');
CREATE TRIGGER issue_guard BEFORE INSERT ON invitations BEGIN
 SELECT CASE WHEN NEW.status!='blocked' OR NEW.digest IS NULL OR NEW.revision!=COALESCE((SELECT MAX(revision)+1 FROM invitations WHERE member_id=NEW.member_id),1)
  OR NEW.actor_id!=NEW.issuer_id OR NEW.predecessor_id IS NOT (SELECT id FROM invitations WHERE member_id=NEW.member_id ORDER BY revision DESC LIMIT 1)
  OR NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.member_id AND status='pending' AND recipient=NEW.recipient)
  OR NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.issuer_id AND status='active' AND role='owner')
  THEN RAISE(ABORT,'issue conflict') END;
 UPDATE invitations SET status=CASE WHEN expires_at<=NEW.created_at THEN 'expired' ELSE 'superseded' END,digest=NULL,changed_at=NEW.created_at,actor_id=NEW.issuer_id
  WHERE member_id=NEW.member_id AND status IN ('blocked','projected','delivered');
END;
CREATE TRIGGER issued AFTER INSERT ON invitations BEGIN
 INSERT INTO audit_events(actor_id,member_id,artifact_id,action,at) VALUES(NEW.issuer_id,NEW.member_id,NEW.id,'issued',NEW.created_at);
END;
CREATE TRIGGER invite_transition BEFORE UPDATE ON invitations BEGIN
 SELECT CASE WHEN NEW.id!=OLD.id OR NEW.member_id!=OLD.member_id OR NEW.recipient!=OLD.recipient OR NEW.issuer_id!=OLD.issuer_id
  OR NEW.changed_at<OLD.changed_at OR NEW.revision!=OLD.revision OR NEW.predecessor_id IS NOT OLD.predecessor_id OR NEW.created_at!=OLD.created_at OR NEW.expires_at!=OLD.expires_at
  OR NOT ((OLD.status='blocked' AND NEW.status='projected') OR (OLD.status='projected' AND NEW.status='delivered')
   OR (OLD.status='delivered' AND NEW.status='claimed') OR (OLD.status IN ('blocked','projected','delivered') AND NEW.status IN ('expired','superseded','revoked')))
  OR (NEW.status IN ('projected','delivered') AND NEW.digest IS NOT OLD.digest)
  THEN RAISE(ABORT,'invalid invitation transition') END;
 -- Original readback time is immutable after confirmation, including reissue.
 -- These guards run in the same statement as the transition and its audit.
 SELECT CASE WHEN (OLD.status='blocked' AND NEW.status='projected' AND NEW.changed_at-NEW.projected_at>60)
  OR (OLD.status!='blocked' AND (NEW.projected_at IS NOT OLD.projected_at OR NEW.projection_receipt IS NOT OLD.projection_receipt))
  OR (NEW.status='delivered' AND NEW.delivered_at IS NOT NEW.changed_at)
  THEN RAISE(ABORT,'invalid projection freshness') END;
 SELECT CASE WHEN NEW.status='claimed' AND (NEW.claimed_at<OLD.delivered_at OR NEW.claimed_at<OLD.created_at
  OR NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.member_id AND status='pending')) THEN RAISE(ABORT,'claim conflict') END;
END;
CREATE TRIGGER invite_changed AFTER UPDATE ON invitations BEGIN
 INSERT INTO audit_events(actor_id,member_id,artifact_id,action,at)
 VALUES(NEW.actor_id,NEW.member_id,NEW.id,NEW.status,NEW.changed_at);
END;
CREATE TRIGGER claimed AFTER UPDATE OF status ON invitations WHEN NEW.status='claimed' BEGIN
 INSERT INTO identities(provider,subject,member_id,bound_at) VALUES(NEW.claim_provider,NEW.claim_subject,NEW.member_id,NEW.claimed_at);
 UPDATE members SET status='active' WHERE id=NEW.member_id AND status='pending';
END;
CREATE TRIGGER invite_retained BEFORE DELETE ON invitations BEGIN SELECT RAISE(ABORT,'retain invitation history'); END;
CREATE TABLE link_requests (
 id TEXT PRIMARY KEY,
 member_id TEXT NOT NULL REFERENCES members(id),
 current_provider TEXT NOT NULL,
 current_subject TEXT NOT NULL,
 candidate_provider TEXT NOT NULL CHECK(candidate_provider IN ('google','otp','apple')),
 candidate_subject TEXT NOT NULL,
 verified_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at=verified_at+900),
 approved_by TEXT REFERENCES members(id),
 approved_at INTEGER,
 committed_at INTEGER,
 status TEXT NOT NULL CHECK(status IN ('requested','approved','committed'))
) STRICT;
CREATE TRIGGER link_request_guard BEFORE INSERT ON link_requests BEGIN
 SELECT CASE WHEN NEW.status!='requested' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.committed_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM identities i JOIN members m ON m.id=i.member_id WHERE i.member_id=NEW.member_id
  AND i.provider=NEW.current_provider AND i.subject=NEW.current_subject AND m.status='active')
 THEN RAISE(ABORT,'invalid link request') END;
END;
CREATE TRIGGER link_guard BEFORE UPDATE ON link_requests BEGIN
 SELECT CASE WHEN NEW.id!=OLD.id OR NEW.member_id!=OLD.member_id OR NEW.current_provider!=OLD.current_provider OR NEW.current_subject!=OLD.current_subject
  OR NEW.candidate_provider!=OLD.candidate_provider OR NEW.candidate_subject!=OLD.candidate_subject OR NEW.verified_at!=OLD.verified_at OR NEW.expires_at!=OLD.expires_at
  OR NOT ((OLD.status='requested' AND NEW.status='approved' AND NEW.approved_at>=NEW.verified_at AND NEW.approved_at<NEW.expires_at
   AND EXISTS(SELECT 1 FROM members WHERE id=NEW.approved_by AND status='active' AND role='owner'))
   OR (OLD.status='approved' AND NEW.status='committed' AND NEW.approved_by=OLD.approved_by AND NEW.approved_at=OLD.approved_at
    AND NEW.committed_at>=NEW.approved_at AND NEW.committed_at<NEW.expires_at))
  OR NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.approved_by AND role='owner' AND status='active')
  OR NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.member_id AND status='active') THEN RAISE(ABORT,'invalid link transition') END;
END;
CREATE TRIGGER link_committed AFTER UPDATE ON link_requests WHEN NEW.status='committed' BEGIN
 INSERT INTO identities(provider,subject,member_id,bound_at) VALUES(NEW.candidate_provider,NEW.candidate_subject,NEW.member_id,NEW.committed_at);
END;
CREATE TRIGGER link_created AFTER INSERT ON link_requests BEGIN
 INSERT INTO audit_events(actor_id,member_id,artifact_id,action,at) VALUES(NEW.member_id,NEW.member_id,NEW.id,'link-requested',NEW.verified_at);
END;
CREATE TRIGGER link_changed AFTER UPDATE ON link_requests BEGIN
 INSERT INTO audit_events(actor_id,member_id,artifact_id,action,at) VALUES(NEW.approved_by,NEW.member_id,NEW.id,'link-'||NEW.status,COALESCE(NEW.committed_at,NEW.approved_at));
END;
CREATE TABLE revocation_tasks (
 member_id TEXT NOT NULL REFERENCES members(id),
 task TEXT NOT NULL CHECK(task IN ('access-remove-readback','access-session-revoke','jellyfin-disable-sessions-verify','palworld-revoke-verify','status-revoke-verify','live-session-direct-route-test')),
 status TEXT NOT NULL DEFAULT 'owner-action-required' CHECK(status IN ('owner-action-required','owner-verified')),
 PRIMARY KEY(member_id,task)
) STRICT;
CREATE TRIGGER member_no_resurrection BEFORE UPDATE ON members BEGIN
 SELECT CASE WHEN NEW.id!=OLD.id OR NEW.recipient!=OLD.recipient OR NEW.created_at!=OLD.created_at OR OLD.status='revoked'
  OR (OLD.status='active' AND NEW.status NOT IN ('active','revoked')) THEN RAISE(ABORT,'invalid member transition') END;
END;
CREATE TABLE revocations (
 id TEXT PRIMARY KEY,
 member_id TEXT NOT NULL UNIQUE REFERENCES members(id),
 actor_id TEXT NOT NULL REFERENCES members(id),
 at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER revoke_guard BEFORE INSERT ON revocations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.actor_id AND role='owner' AND status='active')
 OR NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.member_id AND status!='revoked') THEN RAISE(ABORT,'revocation denied') END;
END;
CREATE TRIGGER revoked AFTER INSERT ON revocations BEGIN
 INSERT INTO audit_events(actor_id,member_id,action,at) VALUES(NEW.actor_id,NEW.member_id,'revoked',NEW.at);
 UPDATE members SET status='revoked' WHERE id=NEW.member_id;
 DELETE FROM service_grants WHERE member_id=NEW.member_id;
 UPDATE invitations SET status='revoked',digest=NULL,changed_at=NEW.at,actor_id=NEW.actor_id WHERE member_id=NEW.member_id AND status IN ('blocked','projected','delivered');
 INSERT INTO revocation_tasks(member_id,task) VALUES
  (NEW.member_id,'access-remove-readback'),(NEW.member_id,'access-session-revoke'),
  (NEW.member_id,'jellyfin-disable-sessions-verify'),(NEW.member_id,'palworld-revoke-verify'),
  (NEW.member_id,'status-revoke-verify'),(NEW.member_id,'live-session-direct-route-test');
END;
CREATE TABLE projection_attempts (
 id INTEGER PRIMARY KEY,
 invitation_id TEXT NOT NULL REFERENCES invitations(id),
 actor_id TEXT NOT NULL REFERENCES members(id),
 outcome TEXT NOT NULL CHECK(outcome IN ('failed-or-drift','confirmed')),
 at INTEGER NOT NULL
) STRICT;
