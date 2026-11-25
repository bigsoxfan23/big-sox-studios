-- Task 12.2 additive, isolated Phase 2 D1 only. No member or invitation changes.
CREATE TABLE invitation_claim_nonces (
 digest TEXT PRIMARY KEY CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
 session_digest TEXT NOT NULL CHECK(length(session_digest)=64),
 expires_at INTEGER NOT NULL,
 used_at INTEGER
) STRICT;
CREATE INDEX invitation_claim_nonces_expiry ON invitation_claim_nonces(expires_at);
