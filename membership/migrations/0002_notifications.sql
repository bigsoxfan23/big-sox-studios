-- Apply ONLY to isolated membership D1, never Mail Desk. Additive, no PII copy.
CREATE TABLE membership_notify_cases (
 application_id TEXT PRIMARY KEY,
 created_at INTEGER NOT NULL,
 suppress_email INTEGER NOT NULL DEFAULT 0 CHECK(suppress_email IN (0,1)),
 notion_state TEXT NOT NULL DEFAULT 'NEW' CHECK(notion_state IN ('NEW','UNKNOWN','LINKED')),
 notion_page_id TEXT,
 email_state TEXT NOT NULL DEFAULT 'NEW' CHECK(email_state IN ('NEW','UNKNOWN','SENT','SUPPRESSED','REFUSED')),
 lease_until INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 CHECK((notion_state='LINKED') = (notion_page_id IS NOT NULL))
);
-- Reservation is durable even if dispatch/persistence crashes. It is never a
-- retry authorization; UNKNOWN/REFUSED always require manual provider review.
CREATE TABLE membership_notify_send_attempts (
 application_id TEXT PRIMARY KEY REFERENCES membership_notify_cases(application_id),
 utc_day INTEGER NOT NULL
);
CREATE INDEX membership_notify_send_day ON membership_notify_send_attempts(utc_day);
CREATE TABLE membership_notify_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 application_id TEXT NOT NULL REFERENCES membership_notify_cases(application_id),
 kind TEXT NOT NULL CHECK(kind IN ('submitted','status','adopt')),
 revision INTEGER NOT NULL CHECK(revision>0),
 occurred_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','blocked')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt INTEGER NOT NULL DEFAULT 0,
 failure TEXT CHECK(failure IS NULL OR failure IN ('configuration','notion_read','notion_unknown','notion_conflict','notion_update','resend_unknown','resend_refused','storage')),
 UNIQUE(application_id,kind,revision)
);
CREATE UNIQUE INDEX membership_notify_one_submission ON membership_notify_outbox(application_id) WHERE kind IN ('submitted','adopt');
CREATE INDEX membership_notify_due ON membership_notify_outbox(state,next_attempt,id);
CREATE TRIGGER membership_notify_immutable_event BEFORE UPDATE OF application_id,kind,revision,occurred_at ON membership_notify_outbox BEGIN
 SELECT RAISE(ABORT,'immutable notification event');
END;
CREATE TRIGGER membership_notify_immutable_case BEFORE UPDATE OF application_id,created_at,suppress_email ON membership_notify_cases BEGIN
 SELECT RAISE(ABORT,'immutable notification identity');
END;
CREATE TRIGGER membership_notify_submitted AFTER INSERT ON membership_requests BEGIN
 INSERT INTO membership_notify_cases(application_id,created_at,suppress_email,email_state)
 VALUES(NEW.id,NEW.created_at,CASE WHEN NEW.id='c3250338-3691-4fae-a7ae-35ed66a31a23' THEN 1 ELSE 0 END,
 CASE WHEN NEW.id='c3250338-3691-4fae-a7ae-35ed66a31a23' THEN 'SUPPRESSED' ELSE 'NEW' END)
 ON CONFLICT(application_id) DO NOTHING;
 INSERT INTO membership_notify_outbox(application_id,kind,revision,occurred_at)
 SELECT NEW.id,'submitted',NEW.revision,NEW.created_at
 WHERE NOT EXISTS(SELECT 1 FROM membership_notify_outbox WHERE application_id=NEW.id AND kind='adopt');
END;
CREATE TRIGGER membership_notify_status AFTER UPDATE OF status ON membership_requests WHEN NEW.status != OLD.status BEGIN
 -- Legacy applications can sync decisions, but never receive historical mail.
 INSERT INTO membership_notify_cases(application_id,created_at,suppress_email,email_state)
 VALUES(NEW.id,NEW.created_at,1,'SUPPRESSED') ON CONFLICT(application_id) DO NOTHING;
 INSERT INTO membership_notify_outbox(application_id,kind,revision,occurred_at)
 VALUES(NEW.id,'status',NEW.revision,NEW.updated_at) ON CONFLICT DO NOTHING;
END;
-- The supplied UUID is an External Case ID, NOT a Notion page ID.
INSERT INTO membership_notify_cases(application_id,created_at,suppress_email,email_state)
 VALUES('c3250338-3691-4fae-a7ae-35ed66a31a23',0,1,'SUPPRESSED');
INSERT INTO membership_notify_outbox(application_id,kind,revision,occurred_at)
 VALUES('c3250338-3691-4fae-a7ae-35ed66a31a23','adopt',1,0);
INSERT INTO schema_versions VALUES(2,'isolated membership notification outbox');
