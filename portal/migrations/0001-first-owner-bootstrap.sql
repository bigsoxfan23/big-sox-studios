-- OFFLINE SOURCE ONLY. Separate approval is required before any production use.
-- Apply after portal/schema.sql to a fresh, separately approved database.
CREATE TABLE first_owner_bootstrap (
 slot INTEGER PRIMARY KEY CHECK(slot=1),
 nonce TEXT NOT NULL UNIQUE CHECK(length(nonce) BETWEEN 32 AND 128),
 member_id TEXT NOT NULL UNIQUE,
 subject TEXT NOT NULL,
 database_id TEXT NOT NULL,
 revision TEXT NOT NULL,
 session_digest TEXT NOT NULL CHECK(length(session_digest)=64),
 context_digest TEXT NOT NULL CHECK(length(context_digest)=64),
 policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
 approval_digest TEXT NOT NULL UNIQUE CHECK(length(approval_digest)=64),
 approval_audit_id TEXT NOT NULL,
 at INTEGER NOT NULL CHECK(at>=0),
 expires_at INTEGER NOT NULL CHECK(expires_at>at AND expires_at<=at+300)
) STRICT;
CREATE TRIGGER bootstrap_guard BEFORE INSERT ON first_owner_bootstrap BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM first_owner_bootstrap)
  OR EXISTS(SELECT 1 FROM members) OR EXISTS(SELECT 1 FROM identities)
  OR EXISTS(SELECT 1 FROM audit_events) OR EXISTS(SELECT 1 FROM invitations)
  OR EXISTS(SELECT 1 FROM link_requests) OR EXISTS(SELECT 1 FROM revocations)
  OR EXISTS(SELECT 1 FROM service_grants) OR EXISTS(SELECT 1 FROM revocation_tasks)
  OR EXISTS(SELECT 1 FROM projection_attempts)
  THEN RAISE(ABORT,'bootstrap requires pristine database') END;
END;
CREATE TRIGGER bootstrap_created AFTER INSERT ON first_owner_bootstrap BEGIN
 INSERT INTO members(id,recipient,role,status,created_at)
  VALUES(NEW.member_id,NEW.subject,'owner','active',NEW.at);
 INSERT INTO identities(provider,subject,member_id,bound_at)
  VALUES('otp',NEW.subject,NEW.member_id,NEW.at);
 INSERT INTO audit_events(actor_id,member_id,artifact_id,action,at)
  VALUES(NEW.approval_audit_id,NEW.member_id,NEW.nonce,'first-owner-bootstrap',NEW.at);
END;
CREATE TRIGGER bootstrap_immutable BEFORE UPDATE ON first_owner_bootstrap BEGIN
 SELECT RAISE(ABORT,'immutable bootstrap receipt');
END;
CREATE TRIGGER bootstrap_retained BEFORE DELETE ON first_owner_bootstrap BEGIN
 SELECT RAISE(ABORT,'retain bootstrap receipt');
END;
