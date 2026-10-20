-- Additive only. No references, writes, or changes to the permanent campaign.
CREATE TABLE stepup_challenge (
 id TEXT PRIMARY KEY CHECK(length(id)=43),
 challenge TEXT NOT NULL UNIQUE CHECK(length(challenge)=43),
 context TEXT NOT NULL CHECK(length(context)<=8192),
 session_hash TEXT UNIQUE CHECK(session_hash IS NULL OR length(session_hash)=64),
 created INTEGER NOT NULL CHECK(created>=0),
 expires INTEGER NOT NULL CHECK(expires=created+CASE WHEN session_hash IS NULL THEN 120 ELSE 600 END),
 state TEXT NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','verified','used')),
 verified INTEGER,
 consumed INTEGER,
 CHECK(verified IS NULL OR (verified>=created AND verified<expires)),
 CHECK(consumed IS NULL OR (consumed>=verified AND consumed<expires)),
 CHECK(session_hash IS NULL OR state='issued'),
 CHECK((state='issued' AND verified IS NULL AND consumed IS NULL) OR
       (state='verified' AND verified IS NOT NULL AND consumed IS NULL) OR
       (state='used' AND verified IS NOT NULL AND consumed IS NOT NULL))
);
CREATE TRIGGER stepup_challenge_limit BEFORE INSERT ON stepup_challenge
WHEN (SELECT count(*) FROM stepup_challenge)>=128 OR NEW.state<>'issued'
BEGIN SELECT RAISE(ABORT,'stepup capacity'); END;
CREATE TRIGGER stepup_challenge_immutable BEFORE UPDATE ON stepup_challenge
WHEN NEW.id IS NOT OLD.id OR NEW.challenge IS NOT OLD.challenge OR NEW.context IS NOT OLD.context
 OR NEW.created IS NOT OLD.created OR NEW.expires IS NOT OLD.expires
 OR NEW.session_hash IS NOT OLD.session_hash
 OR NOT ((OLD.state='issued' AND NEW.state='verified' AND NEW.consumed IS NULL)
 OR (OLD.state='verified' AND NEW.state='used' AND NEW.verified IS OLD.verified))
BEGIN SELECT RAISE(ABORT,'stepup immutable'); END;
CREATE TABLE stepup_candidate (
 id TEXT PRIMARY KEY CHECK(length(id)=43),
 record TEXT NOT NULL CHECK(length(record)<=8192),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=71),
 context TEXT NOT NULL CHECK(length(context)<=8192),
 created INTEGER NOT NULL,
 expires INTEGER NOT NULL CHECK(expires=created+600),
 proof TEXT UNIQUE,
 public_id TEXT UNIQUE,
 verified INTEGER,
 CHECK((proof IS NULL AND public_id IS NULL AND verified IS NULL) OR
       (proof IS NOT NULL AND public_id IS NOT NULL AND verified IS NOT NULL
        AND length(proof)=43 AND length(public_id)=43 AND verified>=created AND verified<expires))
);
CREATE TRIGGER stepup_candidate_limit BEFORE INSERT ON stepup_candidate
WHEN (SELECT count(*) FROM stepup_candidate)>=64 OR NEW.proof IS NOT NULL OR NEW.public_id IS NOT NULL OR NEW.verified IS NOT NULL
BEGIN SELECT RAISE(ABORT,'candidate capacity'); END;
CREATE TRIGGER stepup_candidate_immutable BEFORE UPDATE ON stepup_candidate
WHEN NEW.id IS NOT OLD.id OR NEW.record IS NOT OLD.record OR NEW.fingerprint IS NOT OLD.fingerprint
 OR NEW.context IS NOT OLD.context OR NEW.created IS NOT OLD.created OR NEW.expires IS NOT OLD.expires
 OR OLD.proof IS NOT NULL OR NEW.proof IS NULL OR NEW.verified IS NULL
 OR OLD.public_id IS NOT NULL OR NEW.public_id IS NULL
BEGIN SELECT RAISE(ABORT,'untrusted candidate immutable'); END;
