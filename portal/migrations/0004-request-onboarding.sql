-- Additive Phase2-only migration. Never run against the Task11 request database.
-- Request and member records remain in their original, separate databases.
CREATE TABLE member_onboarding (
 source_database TEXT NOT NULL,
 request_id TEXT NOT NULL,
 request_revision INTEGER NOT NULL CHECK(request_revision > 0),
 member_id TEXT NOT NULL UNIQUE REFERENCES members(id),
 actor_id TEXT NOT NULL REFERENCES members(id),
 approved_at INTEGER NOT NULL,
 jellyfin_ready_at INTEGER,
 jellyfin_username TEXT,
 jellyfin_url TEXT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
 PRIMARY KEY(source_database,request_id),
 CHECK((jellyfin_ready_at IS NULL AND jellyfin_username IS NULL AND jellyfin_url IS NULL)
 OR (jellyfin_ready_at IS NOT NULL AND length(jellyfin_username) BETWEEN 1 AND 128 AND jellyfin_url IS NOT NULL))
) STRICT;
CREATE TRIGGER onboarding_created AFTER INSERT ON member_onboarding BEGIN
 INSERT INTO audit_events(actor_id,member_id,artifact_id,action,at)
 VALUES(NEW.actor_id,NEW.member_id,NEW.request_id,'request-linked-pending',NEW.approved_at);
END;
CREATE TRIGGER onboarding_identity_immutable BEFORE UPDATE ON member_onboarding
 WHEN NEW.source_database!=OLD.source_database OR NEW.request_id!=OLD.request_id
 OR NEW.request_revision!=OLD.request_revision OR NEW.member_id!=OLD.member_id
 OR NEW.actor_id!=OLD.actor_id OR NEW.approved_at!=OLD.approved_at
 BEGIN SELECT RAISE(ABORT,'immutable onboarding link'); END;
CREATE TRIGGER onboarding_ready AFTER UPDATE ON member_onboarding
 WHEN OLD.jellyfin_ready_at IS NULL AND NEW.jellyfin_ready_at IS NOT NULL BEGIN
 INSERT INTO audit_events(actor_id,member_id,artifact_id,action,at)
 VALUES(NEW.actor_id,NEW.member_id,NEW.request_id,'jellyfin-manually-ready',NEW.jellyfin_ready_at);
END;
