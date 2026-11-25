-- Task 12 PRIVATE ACCEPTANCE ONLY. New isolated D1; never run against production or historical staging.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS acceptance_requests (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 run_id TEXT NOT NULL UNIQUE,
 recipient_digest TEXT NOT NULL CHECK(length(recipient_digest)=64),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','revoked')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 10),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 approved_at INTEGER,
 revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS acceptance_effects (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 request_id TEXT NOT NULL REFERENCES acceptance_requests(id),
 kind TEXT NOT NULL CHECK(kind IN ('notion_ticket','owner_notice','test_welcome')),
 recipient_digest TEXT NOT NULL CHECK(length(recipient_digest)=64),
 state TEXT NOT NULL CHECK(state IN ('reserved','accepted','unknown','refused')),
 attempt_count INTEGER NOT NULL DEFAULT 1 CHECK(attempt_count=1),
 provider_id TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(request_id,kind,recipient_digest)
);
CREATE TRIGGER IF NOT EXISTS acceptance_effect_no_delete BEFORE DELETE ON acceptance_effects BEGIN
 SELECT RAISE(ABORT,'immutable TEST effect');
END;
CREATE TRIGGER IF NOT EXISTS acceptance_effect_no_reset BEFORE UPDATE ON acceptance_effects WHEN
 OLD.id!=NEW.id OR OLD.request_id!=NEW.request_id OR OLD.kind!=NEW.kind
 OR OLD.recipient_digest!=NEW.recipient_digest OR OLD.attempt_count!=NEW.attempt_count
 OR OLD.state!='reserved' OR NEW.state='reserved'
 BEGIN SELECT RAISE(ABORT,'immutable TEST dispatch attempt');END;
CREATE TABLE IF NOT EXISTS acceptance_audit (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 request_id TEXT NOT NULL REFERENCES acceptance_requests(id),
 event TEXT NOT NULL,
 actor TEXT NOT NULL CHECK(actor IN ('tester','owner','system')),
 occurred_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS acceptance_audit_no_update BEFORE UPDATE ON acceptance_audit BEGIN
 SELECT RAISE(ABORT,'immutable TEST audit');END;
CREATE TRIGGER IF NOT EXISTS acceptance_audit_no_delete BEFORE DELETE ON acceptance_audit BEGIN
 SELECT RAISE(ABORT,'immutable TEST audit');END;
