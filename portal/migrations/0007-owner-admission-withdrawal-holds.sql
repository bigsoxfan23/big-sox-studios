-- Task12 SOURCE ONLY. Add in isolated Members D1 after migrations 0004-0006.
-- Owner withdrawal writes this terminal hold BEFORE changing Requests D1.
-- First-login CAS checks this SAME Members D1 for a hold in its transaction.
-- An active Member is NEVER auto-revoked. Owner removal remains separate.
CREATE TABLE member_approval_holds (
 source_database TEXT NOT NULL,
 request_id TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES members(id),
 request_revision INTEGER NOT NULL CHECK(request_revision>0),
 held_at INTEGER NOT NULL CHECK(held_at>=0),
 PRIMARY KEY(source_database,request_id)
) STRICT;
CREATE TRIGGER member_approval_hold_owner BEFORE INSERT ON member_approval_holds
 WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.actor_id AND role='owner' AND status='active')
 OR length(NEW.source_database)<1 OR length(NEW.request_id)<1
 OR NEW.held_at>unixepoch('now')+5
 BEGIN SELECT RAISE(ABORT,'Owner approval hold unavailable'); END;
CREATE TRIGGER member_approval_hold_immutable BEFORE UPDATE ON member_approval_holds
 BEGIN SELECT RAISE(ABORT,'immutable Owner approval hold'); END;
CREATE TRIGGER member_approval_hold_retained BEFORE DELETE ON member_approval_holds
 BEGIN SELECT RAISE(ABORT,'retain Owner approval hold'); END;
CREATE TRIGGER member_approval_hold_audit AFTER INSERT ON member_approval_holds BEGIN
 INSERT INTO audit_events(actor_id,member_id,artifact_id,action,at)
 VALUES(NEW.actor_id,
  COALESCE((SELECT member_id FROM member_onboarding
   WHERE source_database=NEW.source_database AND request_id=NEW.request_id),NEW.actor_id),
  NEW.request_id,'owner-approval-withdrawal-hold',NEW.held_at);
END;
