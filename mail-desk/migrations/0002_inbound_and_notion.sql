-- Additive only. Never delete receipt keys or reset uncertain forwarding states.
CREATE TABLE email_receipts (
 receipt_key TEXT PRIMARY KEY, claim_token TEXT NOT NULL UNIQUE,
 case_id TEXT NOT NULL REFERENCES cases(id) DEFERRABLE INITIALLY DEFERRED,
 envelope_from TEXT NOT NULL, envelope_to TEXT NOT NULL, message_id TEXT,
 in_reply_to TEXT, references_json TEXT NOT NULL,
 forward_state TEXT NOT NULL CHECK(forward_state IN ('claimed','UNKNOWN','forwarded')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX email_thread_lookup ON email_receipts(envelope_from,envelope_to,message_id);
CREATE INDEX email_forward_reconcile ON email_receipts(forward_state,updated_at);
CREATE TABLE notion_links (
 case_id TEXT PRIMARY KEY REFERENCES cases(id), page_id TEXT UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('creating','linked','UNKNOWN')), updated_at INTEGER NOT NULL
);
