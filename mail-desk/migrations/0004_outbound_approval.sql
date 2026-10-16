-- Strictly additive; no historical receipt/authentication/approval backfill.
-- Evidence is produced only by a future independently reviewed ingress verifier.
CREATE TABLE outbound_provenance (
 receipt_key TEXT PRIMARY KEY REFERENCES email_receipts(receipt_key),
 message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
 policy TEXT NOT NULL CHECK(policy='maildesk-ingress-v1'),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 signature TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER outbound_provenance_immutable BEFORE UPDATE ON outbound_provenance
 BEGIN SELECT RAISE(ABORT,'immutable_provenance'); END;
CREATE TRIGGER outbound_provenance_no_delete BEFORE DELETE ON outbound_provenance
 BEGIN SELECT RAISE(ABORT,'durable_provenance'); END;
CREATE TRIGGER outbound_provenance_link BEFORE INSERT ON outbound_provenance
 WHEN NOT EXISTS(SELECT 1 FROM email_receipt_messages rm
 JOIN email_receipts r ON r.receipt_key=rm.receipt_key
 JOIN messages m ON m.id=rm.message_id AND m.case_id=r.case_id
 WHERE rm.receipt_key=NEW.receipt_key AND rm.message_id=NEW.message_id AND m.direction='inbound' AND r.forward_state='forwarded')
 BEGIN SELECT RAISE(ABORT,'provenance_link'); END;

CREATE TABLE live_outbound_reviews (
 id TEXT PRIMARY KEY,
 case_id TEXT NOT NULL REFERENCES cases(id),
 receipt_key TEXT NOT NULL REFERENCES outbound_provenance(receipt_key),
 message_id TEXT NOT NULL REFERENCES messages(id), revision INTEGER NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose='maildesk-live-review-v2'),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 session_hash TEXT NOT NULL, approval_expires INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','approved','dispatching','sent','failed','UNKNOWN')),
 provider_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(case_id,revision), CHECK(approval_expires>created_at AND approval_expires<=created_at+600),
 CHECK((status='sent' AND provider_id IS NOT NULL) OR (status<>'sent' AND provider_id IS NULL))
);
CREATE INDEX live_outbound_case ON live_outbound_reviews(case_id,status);
CREATE TRIGGER live_review_initial BEFORE INSERT ON live_outbound_reviews
 WHEN NEW.status<>'reserved' OR NOT EXISTS(SELECT 1 FROM outbound_provenance p
 JOIN email_receipts r ON r.receipt_key=p.receipt_key
 JOIN messages m ON m.id=p.message_id AND m.case_id=r.case_id
 WHERE p.receipt_key=NEW.receipt_key AND p.message_id=NEW.message_id AND r.case_id=NEW.case_id
 AND r.forward_state='forwarded' AND m.direction='inbound')
 BEGIN SELECT RAISE(ABORT,'review_link'); END;
CREATE TRIGGER live_review_immutable BEFORE UPDATE ON live_outbound_reviews
 WHEN NEW.id IS NOT OLD.id OR NEW.case_id IS NOT OLD.case_id OR NEW.receipt_key IS NOT OLD.receipt_key
 OR NEW.message_id IS NOT OLD.message_id OR NEW.revision IS NOT OLD.revision OR NEW.purpose IS NOT OLD.purpose
 OR NEW.snapshot_json IS NOT OLD.snapshot_json OR NEW.session_hash IS NOT OLD.session_hash
 OR NEW.approval_expires IS NOT OLD.approval_expires OR NEW.created_at IS NOT OLD.created_at
 BEGIN SELECT RAISE(ABORT,'immutable_review'); END;
CREATE TRIGGER live_review_transition BEFORE UPDATE ON live_outbound_reviews
 WHEN NEW.updated_at<OLD.updated_at OR NOT (
 (OLD.status='reserved' AND NEW.status='approved') OR
 (OLD.status='approved' AND NEW.status='dispatching') OR
 (OLD.status='dispatching' AND NEW.status IN ('sent','failed','UNKNOWN')))
 BEGIN SELECT RAISE(ABORT,'unsafe_delivery_transition'); END;
CREATE TRIGGER live_review_no_delete BEFORE DELETE ON live_outbound_reviews
 BEGIN SELECT RAISE(ABORT,'durable_review'); END;
-- Protect provenance sources once captured. New inbound inserts remain compatible.
CREATE TRIGGER live_receipt_freeze BEFORE UPDATE ON email_receipts
 WHEN EXISTS(SELECT 1 FROM outbound_provenance p WHERE p.receipt_key=OLD.receipt_key)
 BEGIN SELECT RAISE(ABORT,'immutable_receipt_source'); END;
CREATE TRIGGER live_mapping_freeze BEFORE UPDATE ON email_receipt_messages
 WHEN EXISTS(SELECT 1 FROM outbound_provenance p WHERE p.receipt_key=OLD.receipt_key)
 BEGIN SELECT RAISE(ABORT,'immutable_mapping_source'); END;
CREATE TRIGGER live_message_freeze BEFORE UPDATE ON messages
 WHEN EXISTS(SELECT 1 FROM outbound_provenance p WHERE p.message_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'immutable_message_source'); END;
-- Mutual exclusion also covers old mock Worker code after additive migration.
CREATE TRIGGER live_case_lock BEFORE UPDATE OF draft,revision ON cases
 WHEN EXISTS(SELECT 1 FROM live_outbound_reviews l WHERE l.case_id=OLD.id AND l.status IN ('dispatching','UNKNOWN'))
 BEGIN SELECT RAISE(ABORT,'delivery_reconciliation_required'); END;
CREATE TRIGGER mock_live_claim_lock BEFORE UPDATE OF status ON outbound_intents
 WHEN NEW.status='dispatching' AND EXISTS(SELECT 1 FROM live_outbound_reviews l
 WHERE l.case_id=NEW.case_id AND (l.status IN ('dispatching','UNKNOWN') OR l.revision=NEW.revision))
 BEGIN SELECT RAISE(ABORT,'delivery_conflict'); END;
CREATE TRIGGER live_mock_claim_lock BEFORE UPDATE OF status ON live_outbound_reviews
 WHEN NEW.status='dispatching' AND EXISTS(SELECT 1 FROM outbound_intents o
 WHERE o.case_id=NEW.case_id AND (o.status IN ('dispatching','UNKNOWN') OR o.revision=NEW.revision))
 BEGIN SELECT RAISE(ABORT,'delivery_conflict'); END;
CREATE TRIGGER live_mapping_no_delete BEFORE DELETE ON email_receipt_messages
 WHEN EXISTS(SELECT 1 FROM outbound_provenance p WHERE p.receipt_key=OLD.receipt_key)
 BEGIN SELECT RAISE(ABORT,'durable_mapping_source'); END;
CREATE TRIGGER live_other_claim_lock BEFORE UPDATE OF status ON live_outbound_reviews
 WHEN NEW.status='dispatching' AND EXISTS(SELECT 1 FROM live_outbound_reviews l
 WHERE l.case_id=NEW.case_id AND l.id<>NEW.id AND l.status IN ('dispatching','UNKNOWN'))
 BEGIN SELECT RAISE(ABORT,'delivery_conflict'); END;
