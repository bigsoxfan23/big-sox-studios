-- Additive: retain all prior tables, receipt tombstones and Notion links unchanged.
-- Separate mapping keeps the prior Worker's positional receipt INSERT compatible.
CREATE TABLE email_receipt_messages (
 receipt_key TEXT PRIMARY KEY REFERENCES email_receipts(receipt_key),
 message_id TEXT NOT NULL UNIQUE REFERENCES messages(id)
);
CREATE TABLE notion_activity_links (
 message_id TEXT PRIMARY KEY REFERENCES messages(id),
 case_id TEXT NOT NULL REFERENCES cases(id), page_id TEXT UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('creating','linked','UNKNOWN')),
 updated_at INTEGER NOT NULL
);
CREATE INDEX notion_activity_case ON notion_activity_links(case_id,state);

-- Read failures before a create claim need pacing without suppressing first creation.
-- No error text, token or customer fields are stored here.
CREATE TABLE notion_sync_backoff (
 case_id TEXT PRIMARY KEY REFERENCES cases(id), updated_at INTEGER NOT NULL
);
