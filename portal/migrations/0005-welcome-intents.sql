-- Additive Members staging only. Bodies/passwords are intentionally absent.
CREATE TABLE welcome_intents (
 id TEXT PRIMARY KEY,
 source_database TEXT NOT NULL,
 request_id TEXT NOT NULL,
 member_id TEXT NOT NULL REFERENCES members(id),
 actor_id TEXT NOT NULL REFERENCES members(id),
 onboarding_revision INTEGER NOT NULL,
 recipient TEXT NOT NULL,
 confirmation_digest TEXT NOT NULL UNIQUE CHECK(length(confirmation_digest)=64 AND confirmation_digest NOT GLOB '*[^0-9a-f]*'),
 mode TEXT NOT NULL CHECK(mode IN ('simulated','live')),
 state TEXT NOT NULL CHECK(state IN ('dispatching','accepted','failed','UNKNOWN')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
 provider_id TEXT,
 FOREIGN KEY(source_database,request_id) REFERENCES member_onboarding(source_database,request_id),
 CHECK((state='accepted' AND provider_id IS NOT NULL) OR (state<>'accepted' AND provider_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX one_welcome_outcome ON welcome_intents(source_database,request_id,mode)
 WHERE state IN ('dispatching','accepted','UNKNOWN');
CREATE TRIGGER welcome_initial BEFORE INSERT ON welcome_intents
 WHEN NEW.state<>'dispatching' OR NEW.created_at<>NEW.updated_at OR NOT EXISTS(
 SELECT 1 FROM member_onboarding o JOIN members m ON m.id=o.member_id
 WHERE o.source_database=NEW.source_database AND o.request_id=NEW.request_id
 AND o.member_id=NEW.member_id AND o.revision=NEW.onboarding_revision
 AND o.jellyfin_ready_at IS NOT NULL AND m.role='member' AND m.status='pending' AND m.recipient=NEW.recipient
 AND EXISTS(SELECT 1 FROM members WHERE id=NEW.actor_id AND role='owner' AND status='active'))
 BEGIN SELECT RAISE(ABORT,'welcome unavailable'); END;
CREATE TRIGGER welcome_immutable BEFORE UPDATE ON welcome_intents
 WHEN NEW.id IS NOT OLD.id OR NEW.source_database IS NOT OLD.source_database OR NEW.request_id IS NOT OLD.request_id
 OR NEW.member_id IS NOT OLD.member_id OR NEW.actor_id IS NOT OLD.actor_id OR NEW.onboarding_revision IS NOT OLD.onboarding_revision
 OR NEW.recipient IS NOT OLD.recipient OR NEW.confirmation_digest IS NOT OLD.confirmation_digest OR NEW.mode IS NOT OLD.mode OR NEW.created_at IS NOT OLD.created_at
 OR OLD.state<>'dispatching' OR NEW.state NOT IN ('accepted','failed','UNKNOWN')
 BEGIN SELECT RAISE(ABORT,'welcome reconciliation required'); END;
CREATE TRIGGER welcome_retained BEFORE DELETE ON welcome_intents
 BEGIN SELECT RAISE(ABORT,'retain welcome history'); END;
CREATE TRIGGER welcome_started AFTER INSERT ON welcome_intents BEGIN
 INSERT INTO audit_events(actor_id,member_id,artifact_id,action,at)
 VALUES(NEW.actor_id,NEW.member_id,NEW.id,'welcome-'||NEW.mode||'-dispatching',NEW.created_at);
END;
CREATE TRIGGER welcome_finished AFTER UPDATE ON welcome_intents BEGIN
 INSERT INTO audit_events(actor_id,member_id,artifact_id,action,at)
 VALUES(NEW.actor_id,NEW.member_id,NEW.id,'welcome-'||NEW.mode||'-'||NEW.state,NEW.updated_at);
END;
