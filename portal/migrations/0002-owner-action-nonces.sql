-- Task 12.1: one-use, session-bound CSRF protection for owner actions.
-- Apply to the existing isolated Phase 2 D1 only after reviewed approval and backup.
CREATE TABLE owner_action_nonces (
 digest TEXT PRIMARY KEY CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
 actor_id TEXT NOT NULL REFERENCES members(id),
 session_digest TEXT NOT NULL CHECK(length(session_digest)=64 AND session_digest NOT GLOB '*[^0-9a-f]*'),
 issued_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+600),
 used_at INTEGER CHECK(used_at IS NULL OR (used_at>=issued_at AND used_at<expires_at))
) STRICT;
CREATE INDEX owner_action_nonces_expiry ON owner_action_nonces(expires_at);
