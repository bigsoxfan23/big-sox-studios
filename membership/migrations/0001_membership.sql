-- New, separate bss-membership-requests database ONLY. Millisecond UTC timestamps.
PRAGMA foreign_keys = ON;
CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, description TEXT NOT NULL);
INSERT INTO schema_versions VALUES (1, 'membership requests and minimal audit');
CREATE TABLE membership_requests (
 id TEXT PRIMARY KEY,
 email_hash TEXT NOT NULL UNIQUE,
 name TEXT, email TEXT, reason TEXT, owner_note TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','revoked','expired')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 closed_at INTEGER, pii_cleared_at INTEGER,
 CHECK(name IS NULL OR length(name) <= 100),
 CHECK(email IS NULL OR length(email) <= 254),
 CHECK(reason IS NULL OR length(reason) <= 500),
 CHECK(owner_note IS NULL OR length(owner_note) <= 500)
);
CREATE INDEX requests_queue ON membership_requests(created_at DESC, id DESC);
CREATE INDEX requests_retention ON membership_requests(status, closed_at, created_at);
CREATE INDEX requests_pending_age ON membership_requests(created_at) WHERE status='pending';
CREATE INDEX requests_pii_age ON membership_requests(closed_at)
 WHERE pii_cleared_at IS NULL AND status IN ('rejected','revoked','expired');
CREATE TABLE audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id TEXT NOT NULL, event TEXT NOT NULL,
 from_status TEXT, to_status TEXT NOT NULL,
 revision INTEGER NOT NULL, occurred_at INTEGER NOT NULL
);
CREATE INDEX audit_ttl ON audit_events(occurred_at);
-- Triggers make request mutation + audit one atomic SQLite statement.
CREATE TRIGGER request_created AFTER INSERT ON membership_requests BEGIN
 INSERT INTO audit_events(request_id,event,to_status,revision,occurred_at)
 VALUES(NEW.id,'submitted',NEW.status,NEW.revision,NEW.created_at);
END;
CREATE TRIGGER request_changed AFTER UPDATE ON membership_requests
 WHEN NEW.revision != OLD.revision BEGIN
 INSERT INTO audit_events(request_id,event,from_status,to_status,revision,occurred_at)
 VALUES(NEW.id,CASE WHEN NEW.pii_cleared_at IS NOT OLD.pii_cleared_at THEN 'pii_cleared'
 WHEN NEW.status = OLD.status THEN 'note_updated' ELSE 'status_changed' END,
 OLD.status,NEW.status,NEW.revision,NEW.updated_at);
END;
