-- EXACT DELTA after already-applied acceptance/members.sql.
-- MEMBERS ONLY: adf83cdc-e8df-4cc4-acd5-3f89ce6f34ea
CREATE TABLE acceptance_database_identity (id TEXT PRIMARY KEY CHECK(id='adf83cdc-e8df-4cc4-acd5-3f89ce6f34ea'));
CREATE TRIGGER acceptance_member_no_delete BEFORE DELETE ON acceptance_members BEGIN SELECT RAISE(ABORT,'retain TEST member'); END;
CREATE TRIGGER acceptance_member_transition BEFORE UPDATE ON acceptance_members WHEN OLD.id!=NEW.id OR OLD.request_id!=NEW.request_id OR OLD.run_id!=NEW.run_id OR OLD.recipient_digest!=NEW.recipient_digest OR OLD.created_at!=NEW.created_at OR NOT ((OLD.status='pending' AND NEW.status IN ('active','revoked')) OR (OLD.status='active' AND NEW.status='revoked')) BEGIN SELECT RAISE(ABORT,'invalid TEST member transition'); END;
CREATE TRIGGER acceptance_identity_no_update BEFORE UPDATE ON acceptance_identities BEGIN SELECT RAISE(ABORT,'retain TEST identity'); END;
CREATE TRIGGER acceptance_identity_no_delete BEFORE DELETE ON acceptance_identities BEGIN SELECT RAISE(ABORT,'retain TEST identity'); END;
CREATE TRIGGER acceptance_member_audit_insert AFTER INSERT ON acceptance_members BEGIN INSERT INTO acceptance_member_audit VALUES(NEW.id,NEW.id,'pending',unixepoch()); END;
CREATE TRIGGER acceptance_member_audit_update AFTER UPDATE ON acceptance_members BEGIN INSERT INTO acceptance_member_audit VALUES(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),NEW.id,NEW.status,unixepoch()); END;
CREATE TRIGGER acceptance_member_pending_only BEFORE INSERT ON acceptance_members WHEN NEW.status!='pending' OR NEW.active_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.welcome_effect_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'pending TEST member required'); END;
CREATE TRIGGER acceptance_member_activation BEFORE UPDATE ON acceptance_members WHEN (NEW.status='active' AND (NEW.welcome_effect_id IS NULL OR NEW.active_at IS NULL)) OR (NEW.status='revoked' AND NEW.revoked_at IS NULL) OR (NEW.status='revoked' AND (NEW.welcome_effect_id IS NOT OLD.welcome_effect_id OR NEW.active_at IS NOT OLD.active_at)) BEGIN SELECT RAISE(ABORT,'invalid TEST membership evidence'); END;
CREATE TRIGGER acceptance_identity_binding BEFORE INSERT ON acceptance_identities WHEN NOT EXISTS(SELECT 1 FROM acceptance_members WHERE id=NEW.member_id AND recipient_digest=NEW.subject_digest AND status IN ('pending','active')) BEGIN SELECT RAISE(ABORT,'invalid TEST identity binding'); END;
-- Completion marker is last: a partial delta must remain unavailable.
INSERT INTO acceptance_database_identity VALUES('adf83cdc-e8df-4cc4-acd5-3f89ce6f34ea');
