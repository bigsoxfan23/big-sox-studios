-- Additive, no backfill: historical intents without a row remain simulated.
CREATE TABLE reply_review_modes (
 intent_id TEXT PRIMARY KEY REFERENCES outbound_intents(id),
 mode TEXT NOT NULL CHECK(mode IN ('mock','live'))
);
CREATE TRIGGER reply_mode_initial BEFORE INSERT ON reply_review_modes
 WHEN NOT EXISTS(SELECT 1 FROM outbound_intents WHERE id=NEW.intent_id AND status='reserved')
 BEGIN SELECT RAISE(ABORT,'reply_reservation_required'); END;
CREATE TRIGGER reply_mode_immutable BEFORE UPDATE ON reply_review_modes
 BEGIN SELECT RAISE(ABORT,'immutable_reply_mode'); END;
CREATE TRIGGER reply_mode_durable BEFORE DELETE ON reply_review_modes
 BEGIN SELECT RAISE(ABORT,'durable_reply_mode'); END;
CREATE TRIGGER simple_reply_snapshot BEFORE UPDATE ON outbound_intents
 WHEN EXISTS(SELECT 1 FROM reply_review_modes WHERE intent_id=OLD.id AND mode='live')
 AND (NEW.id IS NOT OLD.id OR NEW.case_id IS NOT OLD.case_id OR NEW.revision IS NOT OLD.revision
 OR NEW.recipient IS NOT OLD.recipient OR NEW.sender IS NOT OLD.sender OR NEW.subject IS NOT OLD.subject
 OR NEW.body IS NOT OLD.body OR NEW.session_hash IS NOT OLD.session_hash
 OR NEW.approval_expires IS NOT OLD.approval_expires OR NEW.created_at IS NOT OLD.created_at)
 BEGIN SELECT RAISE(ABORT,'immutable_reply_snapshot'); END;
CREATE TRIGGER simple_reply_transition BEFORE UPDATE ON outbound_intents
 WHEN EXISTS(SELECT 1 FROM reply_review_modes WHERE intent_id=OLD.id AND mode='live')
 AND NOT ((OLD.status='reserved' AND NEW.status='dispatching')
 OR (OLD.status='dispatching' AND NEW.status IN ('sent','failed','UNKNOWN')))
 BEGIN SELECT RAISE(ABORT,'unsafe_reply_transition'); END;
CREATE TRIGGER simple_reply_durable BEFORE DELETE ON outbound_intents
 WHEN EXISTS(SELECT 1 FROM reply_review_modes WHERE intent_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'durable_reply_intent'); END;
