-- SOURCE-ONLY ADDITIVE MIGRATION; NOT APPLIED. Exact isolated TEST Requests D1 ONLY.
-- Physical ID: 5f333c95-de64-4a37-8467-8a0bbba7dd9b
-- Requires acceptance/requests.sql and migration-0002-requests.sql.
-- Operator-only SQL writes after independent fresh evidence; no Worker write endpoint.
CREATE TABLE acceptance_preflight_lease (
 role TEXT PRIMARY KEY CHECK(role IN ('owner','member')),
 run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 16 AND 64),
 nonce_digest TEXT NOT NULL CHECK(length(nonce_digest)=64),
 revision TEXT NOT NULL CHECK(revision='task12-private-acceptance-v1'),
 generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 2147483647),
 issued_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 signed_token TEXT NOT NULL CHECK(length(signed_token) BETWEEN 32 AND 4096),
 snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) BETWEEN 100 AND 12288),
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
 CHECK(expires_at>issued_at AND expires_at-issued_at<=300)
);
CREATE TRIGGER acceptance_preflight_insert_run BEFORE INSERT ON acceptance_preflight_lease
 WHEN EXISTS(SELECT 1 FROM acceptance_run WHERE singleton=1 AND
       (run_id!=NEW.run_id OR nonce_digest!=NEW.nonce_digest))
 BEGIN SELECT RAISE(ABORT,'preflight run mismatch'); END;
CREATE TRIGGER acceptance_preflight_renew_guard BEFORE UPDATE ON acceptance_preflight_lease
 WHEN OLD.revoked=1 OR NEW.role!=OLD.role OR NEW.run_id!=OLD.run_id OR
      NEW.nonce_digest!=OLD.nonce_digest OR NEW.revision!=OLD.revision OR
      NOT (
        (OLD.revoked=0 AND NEW.revoked=1 AND NEW.generation=OLD.generation AND
         NEW.issued_at=OLD.issued_at AND NEW.expires_at=OLD.expires_at AND
         NEW.signed_token=OLD.signed_token AND NEW.snapshot_json=OLD.snapshot_json)
        OR
        (OLD.revoked=0 AND NEW.revoked=0 AND NEW.generation=OLD.generation+1 AND
         NEW.issued_at>OLD.issued_at AND NEW.expires_at>NEW.issued_at)
      )
 BEGIN SELECT RAISE(ABORT,'invalid TEST preflight renewal'); END;
CREATE TRIGGER acceptance_preflight_no_delete BEFORE DELETE ON acceptance_preflight_lease
 BEGIN SELECT RAISE(ABORT,'TEST preflight retention'); END;
CREATE TABLE acceptance_preflight_history (
 role TEXT NOT NULL CHECK(role IN ('owner','member')),
 generation INTEGER NOT NULL,
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
 run_id TEXT NOT NULL,
 issued_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 signed_token TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 recorded_at INTEGER NOT NULL,
 PRIMARY KEY(role,generation,revoked)
);
CREATE TRIGGER acceptance_preflight_history_no_update BEFORE UPDATE ON acceptance_preflight_history
 BEGIN SELECT RAISE(ABORT,'immutable preflight history'); END;
CREATE TRIGGER acceptance_preflight_history_no_delete BEFORE DELETE ON acceptance_preflight_history
 BEGIN SELECT RAISE(ABORT,'immutable preflight history'); END;
CREATE TRIGGER acceptance_preflight_history_insert AFTER INSERT ON acceptance_preflight_lease
 BEGIN INSERT INTO acceptance_preflight_history
 VALUES(NEW.role,NEW.generation,NEW.revoked,NEW.run_id,NEW.issued_at,NEW.expires_at,NEW.signed_token,NEW.snapshot_json,unixepoch()); END;
CREATE TRIGGER acceptance_preflight_history_renew AFTER UPDATE ON acceptance_preflight_lease
 BEGIN INSERT INTO acceptance_preflight_history
 VALUES(NEW.role,NEW.generation,NEW.revoked,NEW.run_id,NEW.issued_at,NEW.expires_at,NEW.signed_token,NEW.snapshot_json,unixepoch()); END;


-- Operator-owned, one-time bounded TWO-EMAIL risk acceptance for this private run.
-- No Worker route can create/refresh budget proof. Only the existing TEST Requests D1.
-- This is a historical start snapshot, NOT a claim of live Resend quota on renewal.
CREATE TABLE acceptance_send_budget (
 run_id TEXT PRIMARY KEY NOT NULL,
 nonce_digest TEXT NOT NULL CHECK(length(nonce_digest)=64),
 credential_digest TEXT NOT NULL CHECK(length(credential_digest)=64),
 quota_evidence_digest TEXT NOT NULL CHECK(length(quota_evidence_digest)=64),
 quota_observed_at INTEGER NOT NULL CHECK(quota_observed_at>0),
 free_quota_at_start INTEGER NOT NULL CHECK(free_quota_at_start>=2),
 plan TEXT NOT NULL CHECK(plan='free'),
 overages_enabled INTEGER NOT NULL CHECK(overages_enabled=0),
 shared_quota_risk_accepted INTEGER NOT NULL CHECK(shared_quota_risk_accepted=1),
 max_email_attempts INTEGER NOT NULL CHECK(max_email_attempts=2)
);
CREATE TRIGGER acceptance_send_budget_no_update BEFORE UPDATE ON acceptance_send_budget
 BEGIN SELECT RAISE(ABORT,'immutable start-only TEST email budget'); END;
CREATE TRIGGER acceptance_send_budget_no_delete BEFORE DELETE ON acceptance_send_budget
 BEGIN SELECT RAISE(ABORT,'immutable start-only TEST email budget'); END;

-- Exactly one possible owner_notice and one possible test_welcome, including
-- reserved/UNKNOWN/refused as consumed. No duplicate recipient or retry.
CREATE TRIGGER acceptance_email_budget_before_insert BEFORE INSERT ON acceptance_effects
 WHEN NEW.kind IN ('owner_notice','test_welcome') AND (
  (SELECT COUNT(*) FROM acceptance_send_budget
    WHERE run_id=(SELECT run_id FROM acceptance_requests WHERE id=NEW.request_id)
      AND max_email_attempts=2 AND plan='free' AND overages_enabled=0
      AND shared_quota_risk_accepted=1)=0
  OR (SELECT COUNT(*) FROM acceptance_effects WHERE kind IN ('owner_notice','test_welcome'))>=2
 ) BEGIN SELECT RAISE(ABORT,'TEST two-email budget unavailable'); END;


-- Private TEST Notion decision sync, bounded to one write attempt per state.
-- Request D1 remains authority; uncertain Notion updates block welcome,
-- NEVER reopen an email attempt. Approval/revocation are separate audited states.
CREATE TABLE acceptance_notion_decision (
 request_id TEXT NOT NULL REFERENCES acceptance_requests(id),
 decision TEXT NOT NULL CHECK(decision IN ('approved','revoked')),
 intent_id TEXT NOT NULL UNIQUE CHECK(length(intent_id)=36),
 page_id TEXT NOT NULL CHECK(length(page_id)=36),
 decision_at INTEGER NOT NULL CHECK(decision_at>0),
 state TEXT NOT NULL CHECK(state IN ('reserved','accepted','unknown','refused')),
 attempt_count INTEGER NOT NULL DEFAULT 1 CHECK(attempt_count=1),
 provider_id TEXT,
 PRIMARY KEY(request_id,decision)
);
CREATE TRIGGER acceptance_notion_decision_guard BEFORE INSERT ON acceptance_notion_decision
 WHEN NEW.state!='reserved' OR NEW.provider_id IS NOT NULL OR NEW.attempt_count!=1 OR NOT EXISTS(
  SELECT 1 FROM acceptance_requests r JOIN acceptance_effects e ON e.request_id=r.id
  WHERE r.id=NEW.request_id AND r.status=NEW.decision
    AND (CASE NEW.decision WHEN 'approved' THEN r.approved_at ELSE r.revoked_at END)=NEW.decision_at
    AND e.kind='notion_ticket' AND e.state='accepted' AND e.provider_id=NEW.page_id
 ) BEGIN SELECT RAISE(ABORT,'TEST decision must follow accepted private Notion ticket'); END;
CREATE TRIGGER acceptance_notion_decision_terminal BEFORE UPDATE ON acceptance_notion_decision
 WHEN OLD.state!='reserved' OR NEW.state='reserved' OR
  NEW.request_id!=OLD.request_id OR NEW.decision!=OLD.decision OR
  NEW.intent_id!=OLD.intent_id OR NEW.page_id!=OLD.page_id OR
  NEW.decision_at!=OLD.decision_at OR NEW.attempt_count!=1 OR
  (NEW.state='accepted' AND NEW.provider_id!=OLD.page_id) OR
  (NEW.state!='accepted' AND NEW.provider_id IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'immutable TEST Notion decision write'); END;
CREATE TRIGGER acceptance_notion_decision_no_delete BEFORE DELETE ON acceptance_notion_decision
 BEGIN SELECT RAISE(ABORT,'retain TEST Notion decision evidence'); END;
CREATE TRIGGER acceptance_notion_decision_audit AFTER UPDATE ON acceptance_notion_decision
 BEGIN INSERT INTO acceptance_audit VALUES(
  lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),
  NEW.request_id,'notion_decision:'||NEW.decision||':'||NEW.state,'system',unixepoch());
 END;
