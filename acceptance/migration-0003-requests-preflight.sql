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
