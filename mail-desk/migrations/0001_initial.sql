PRAGMA foreign_keys = ON;
CREATE TABLE cases (
 id TEXT PRIMARY KEY, channel TEXT NOT NULL CHECK(channel IN ('members','support','hello')),
 requester_name TEXT NOT NULL, requester_email TEXT NOT NULL, subject TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, draft TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE messages (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id),
 direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')), body TEXT NOT NULL,
 created_at INTEGER NOT NULL, intent_id TEXT UNIQUE
);
CREATE TABLE inbound_dedupe (
 inbound_key TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), created_at INTEGER NOT NULL
);
CREATE TABLE outbound_intents (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), revision INTEGER NOT NULL,
 recipient TEXT NOT NULL, sender TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
 session_hash TEXT NOT NULL, approval_expires INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','dispatching','sent','failed','UNKNOWN')),
 provider_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(case_id, revision)
);
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY, event TEXT NOT NULL, case_id TEXT, intent_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE sync_jobs (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), intent_id TEXT UNIQUE,
 kind TEXT NOT NULL DEFAULT 'delivery_sent' CHECK(kind IN ('case_created','delivery_sent')),
 status TEXT NOT NULL CHECK(status IN ('pending','running','done','dead')) DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE rate_limits (
 bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX cases_updated ON cases(updated_at DESC);
CREATE INDEX messages_thread ON messages(case_id, created_at);
CREATE INDEX outbound_case_status ON outbound_intents(case_id, status);
CREATE INDEX outbound_recovery ON outbound_intents(status, updated_at);
CREATE INDEX sync_due ON sync_jobs(status, next_attempt);
CREATE INDEX audit_retention ON audit_events(created_at);
CREATE INDEX rate_retention ON rate_limits(expires_at);
-- Inbound/send dedupe rows are durable safety records, never independently expired.
-- Retention is an owner-reviewed offline operation; see OPERATIONS.md.
