-- SOURCE ONLY. Add after 0005 in an isolated Members database for local tests.
-- Evidence only: never changes welcome_intents, membership, identities or grants.
-- HMAC Owner/session proof is verified by welcome-reconciliation.mjs before SQL.
-- Neither receipt readback nor this evidence authorizes another dispatch.
CREATE TABLE welcome_reconciliation_events (
 id TEXT PRIMARY KEY NOT NULL,
 intent_id TEXT NOT NULL REFERENCES welcome_intents(id),
 actor_id TEXT NOT NULL REFERENCES members(id),
 intent_state TEXT NOT NULL CHECK(intent_state IN ('dispatching','UNKNOWN','accepted')),
 provider_id TEXT NOT NULL CHECK(length(provider_id)=36
  AND substr(provider_id,9,1)='-' AND substr(provider_id,14,1)='-'
  AND substr(provider_id,19,1)='-' AND substr(provider_id,24,1)='-'
  AND length(replace(provider_id,'-',''))=32 AND replace(provider_id,'-','') NOT GLOB '*[^0-9a-fA-F]*'),
 provider_status TEXT NOT NULL CHECK(provider_status IN ('sent','delivered','delivery_delayed','bounced','complained','failed')),
 observed_at INTEGER NOT NULL CHECK(observed_at>=0),
 recorded_at INTEGER NOT NULL CHECK(recorded_at>=observed_at AND recorded_at-observed_at<=300),
 review_issued_at INTEGER NOT NULL CHECK(review_issued_at>=observed_at AND review_issued_at<=recorded_at),
 review_expires_at INTEGER NOT NULL CHECK(review_expires_at>recorded_at AND review_expires_at<=review_issued_at+300),
 proof_digest TEXT NOT NULL UNIQUE CHECK(length(proof_digest)=64 AND proof_digest NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE INDEX welcome_reconciliation_history ON welcome_reconciliation_events(intent_id,recorded_at);
CREATE TRIGGER welcome_reconciliation_guard BEFORE INSERT ON welcome_reconciliation_events BEGIN
 SELECT CASE WHEN
  -- Also block INSERT OR REPLACE with SQLite recursive_triggers disabled.
  EXISTS(SELECT 1 FROM welcome_reconciliation_events WHERE id=NEW.id OR proof_digest=NEW.proof_digest)
  OR unixepoch('now')<NEW.review_issued_at OR unixepoch('now')>=NEW.review_expires_at
  OR unixepoch('now')-NEW.observed_at>300
  OR NOT EXISTS(SELECT 1 FROM welcome_intents i JOIN members a ON a.id=NEW.actor_id
   WHERE i.id=NEW.intent_id AND i.mode='live' AND i.state=NEW.intent_state
   AND i.state IN ('dispatching','UNKNOWN','accepted') AND i.updated_at<=NEW.observed_at
   AND i.actor_id=NEW.actor_id AND a.role='owner' AND a.status='active'
   AND (i.state<>'accepted' OR i.provider_id=NEW.provider_id))
 THEN RAISE(ABORT,'welcome reconciliation unavailable') END;
END;
CREATE TRIGGER welcome_reconciliation_immutable BEFORE UPDATE ON welcome_reconciliation_events BEGIN
 SELECT RAISE(ABORT,'immutable welcome evidence');
END;
CREATE TRIGGER welcome_reconciliation_retained BEFORE DELETE ON welcome_reconciliation_events BEGIN
 SELECT RAISE(ABORT,'retain welcome evidence');
END;
CREATE TRIGGER welcome_reconciliation_recorded AFTER INSERT ON welcome_reconciliation_events BEGIN
 INSERT INTO audit_events(actor_id,member_id,artifact_id,action,at)
 SELECT NEW.actor_id,i.member_id,NEW.id,'welcome-live-reconciliation-'||NEW.provider_status,NEW.recorded_at
 FROM welcome_intents i WHERE i.id=NEW.intent_id;
END;
