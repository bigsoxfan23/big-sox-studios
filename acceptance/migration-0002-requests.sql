-- EXACT DELTA after already-applied acceptance/requests.sql.
-- REQUESTS ONLY. Never apply to any other database.
-- REQUESTS: 5f333c95-de64-4a37-8467-8a0bbba7dd9b
CREATE TABLE acceptance_database_identity (id TEXT PRIMARY KEY CHECK(id='5f333c95-de64-4a37-8467-8a0bbba7dd9b'));
CREATE TABLE acceptance_run (singleton INTEGER PRIMARY KEY CHECK(singleton=1), run_id TEXT NOT NULL UNIQUE, nonce_digest TEXT NOT NULL CHECK(length(nonce_digest)=64));
CREATE TRIGGER acceptance_run_no_update BEFORE UPDATE ON acceptance_run BEGIN SELECT RAISE(ABORT,'immutable TEST run'); END;
CREATE TRIGGER acceptance_run_no_delete BEFORE DELETE ON acceptance_run BEGIN SELECT RAISE(ABORT,'immutable TEST run'); END;
CREATE TABLE acceptance_outbox (request_id TEXT PRIMARY KEY REFERENCES acceptance_requests(id), state TEXT NOT NULL CHECK(state IN ('ready','locked')));
CREATE TRIGGER acceptance_outbox_no_reset BEFORE UPDATE ON acceptance_outbox WHEN OLD.request_id!=NEW.request_id OR OLD.state!='ready' OR NEW.state!='locked' BEGIN SELECT RAISE(ABORT,'immutable TEST outbox'); END;
CREATE TRIGGER acceptance_outbox_no_delete BEFORE DELETE ON acceptance_outbox BEGIN SELECT RAISE(ABORT,'immutable TEST outbox'); END;
CREATE TRIGGER acceptance_request_insert BEFORE INSERT ON acceptance_requests WHEN NOT EXISTS(SELECT 1 FROM acceptance_run WHERE singleton=1 AND run_id=NEW.run_id) OR EXISTS(SELECT 1 FROM acceptance_requests) BEGIN SELECT RAISE(ABORT,'one TEST request only'); END;
CREATE TRIGGER acceptance_request_no_delete BEFORE DELETE ON acceptance_requests BEGIN SELECT RAISE(ABORT,'retain TEST request'); END;
CREATE TRIGGER acceptance_request_transition BEFORE UPDATE ON acceptance_requests WHEN OLD.id!=NEW.id OR OLD.run_id!=NEW.run_id OR OLD.recipient_digest!=NEW.recipient_digest OR OLD.created_at!=NEW.created_at OR NEW.revision!=OLD.revision+1 OR NOT ((OLD.status='pending' AND NEW.status IN ('approved','revoked')) OR (OLD.status='approved' AND NEW.status='revoked')) BEGIN SELECT RAISE(ABORT,'invalid TEST decision'); END;
CREATE TRIGGER acceptance_request_audit_insert AFTER INSERT ON acceptance_requests BEGIN INSERT INTO acceptance_audit VALUES(NEW.id,NEW.id,'requested','tester',unixepoch()); END;
CREATE TRIGGER acceptance_request_audit_update AFTER UPDATE ON acceptance_requests BEGIN INSERT INTO acceptance_audit VALUES(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),NEW.id,NEW.status,'owner',unixepoch()); END;
CREATE UNIQUE INDEX acceptance_effect_one_kind ON acceptance_effects(request_id,kind);
CREATE TRIGGER acceptance_effect_audit AFTER UPDATE ON acceptance_effects BEGIN INSERT INTO acceptance_audit VALUES(NEW.id,NEW.request_id,NEW.kind||':'||NEW.state,'system',unixepoch()); END;
CREATE TRIGGER acceptance_effect_reserve_only BEFORE INSERT ON acceptance_effects WHEN NEW.state!='reserved' OR NEW.provider_id IS NOT NULL OR NEW.attempt_count!=1 BEGIN SELECT RAISE(ABORT,'reserve TEST effect before IO'); END;
CREATE TRIGGER acceptance_effect_evidence BEFORE UPDATE ON acceptance_effects WHEN NEW.created_at!=OLD.created_at OR (NEW.state='accepted' AND (NEW.provider_id IS NULL OR length(NEW.provider_id) NOT BETWEEN 1 AND 128)) OR (NEW.state!='accepted' AND NEW.provider_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'invalid TEST effect evidence'); END;
CREATE TRIGGER acceptance_effect_reserve_audit AFTER INSERT ON acceptance_effects BEGIN INSERT INTO acceptance_audit VALUES(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),NEW.request_id,NEW.kind||':reserved','owner',unixepoch()); END;
-- Completion marker is last: a partial delta must remain unavailable.
INSERT INTO acceptance_database_identity VALUES('5f333c95-de64-4a37-8467-8a0bbba7dd9b');
