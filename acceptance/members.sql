-- Task 12 PRIVATE ACCEPTANCE ONLY. New isolated D1; ZERO real service grants permitted.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS acceptance_members (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
 run_id TEXT NOT NULL UNIQUE,
 recipient_digest TEXT NOT NULL CHECK(length(recipient_digest)=64),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','revoked')),
 created_at INTEGER NOT NULL,
 active_at INTEGER,
 revoked_at INTEGER,
 welcome_effect_id TEXT CHECK(welcome_effect_id IS NULL OR length(welcome_effect_id)=36)
);
CREATE TABLE IF NOT EXISTS acceptance_identities (
 provider TEXT NOT NULL CHECK(provider='otp'),
 subject_digest TEXT NOT NULL CHECK(length(subject_digest)=64),
 member_id TEXT NOT NULL REFERENCES acceptance_members(id),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(provider,subject_digest),
 UNIQUE(member_id)
);
CREATE TABLE IF NOT EXISTS service_grants (
 id TEXT PRIMARY KEY,
 member_id TEXT NOT NULL,
 service TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS acceptance_forbid_real_grant BEFORE INSERT ON service_grants BEGIN
 SELECT RAISE(ABORT,'TEST MEMBERS MUST NEVER HAVE SERVICE GRANTS'); END;
CREATE TRIGGER IF NOT EXISTS acceptance_forbid_grant_change BEFORE UPDATE ON service_grants BEGIN
 SELECT RAISE(ABORT,'TEST MEMBERS MUST NEVER HAVE SERVICE GRANTS'); END;
CREATE TABLE IF NOT EXISTS acceptance_member_audit (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 member_id TEXT NOT NULL REFERENCES acceptance_members(id),
 event TEXT NOT NULL,
 occurred_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS acceptance_member_audit_immutable_update BEFORE UPDATE ON acceptance_member_audit BEGIN SELECT RAISE(ABORT,'immutable TEST member audit');END;
CREATE TRIGGER IF NOT EXISTS acceptance_member_audit_immutable_delete BEFORE DELETE ON acceptance_member_audit BEGIN SELECT RAISE(ABORT,'immutable TEST member audit');END;
