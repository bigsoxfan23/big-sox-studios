-- Private D1 database schema; not deployed by this repository.
-- Identity subject is provider-scoped. Never auto-link by email.
CREATE TABLE IF NOT EXISTS members (
 id TEXT PRIMARY KEY,
 display_name TEXT,
 role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','trusted','member')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','suspended')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS identities (
 provider TEXT NOT NULL,
 subject TEXT NOT NULL,
 member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 verified_email TEXT,
 PRIMARY KEY(provider,subject)
);
CREATE INDEX IF NOT EXISTS identities_member_idx ON identities(member_id);
CREATE TABLE IF NOT EXISTS service_grants (
 member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 service TEXT NOT NULL CHECK (service IN ('jellyfin','palworld','status')),
 PRIMARY KEY(member_id,service)
);
CREATE TABLE IF NOT EXISTS audit_events (
 id TEXT PRIMARY KEY,
 actor_member_id TEXT,
 action TEXT NOT NULL,
 target_member_id TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
