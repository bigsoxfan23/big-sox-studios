-- Additive, isolated membership DB only. No applicant/provider payloads.
CREATE TABLE membership_notify_provider_check (
 id INTEGER PRIMARY KEY CHECK(id=1),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
 next_attempt INTEGER NOT NULL DEFAULT 0,
 token TEXT
);
INSERT INTO membership_notify_provider_check(id) VALUES(1);
-- Bound completed-event housekeeping by age without a full scan or sort.
CREATE INDEX membership_notify_completed_age ON membership_notify_outbox(state,occurred_at,id);
INSERT INTO schema_versions VALUES(3,'persistent notification provider check budget and indexed housekeeping');
