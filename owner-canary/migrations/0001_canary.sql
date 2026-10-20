-- Dedicated NEW D1 database only. Offline schema: never applied remotely here.
CREATE TABLE canary_campaign (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 campaign TEXT NOT NULL UNIQUE CHECK (length(campaign) = 36),
 snapshot TEXT NOT NULL,
 digest TEXT NOT NULL CHECK (length(digest) = 64),
 binding TEXT NOT NULL CHECK (length(binding) = 64),
 expires INTEGER NOT NULL,
 created INTEGER NOT NULL CHECK (expires > created AND expires <= created + 300),
 status TEXT NOT NULL CHECK (status IN ('previewed','reviewed','approved','submitted','accepted','refused','UNKNOWN')),
 capability TEXT NOT NULL CHECK (length(capability) = 64),
 reviewed INTEGER,
 approved INTEGER,
 claimed INTEGER,
 finished INTEGER,
 provider_id TEXT,
 CHECK (reviewed IS NULL OR reviewed >= created),
 CHECK (approved IS NULL OR (reviewed IS NOT NULL AND approved >= reviewed)),
 CHECK (claimed IS NULL OR (approved IS NOT NULL AND claimed >= approved)),
 CHECK (finished IS NULL OR (claimed IS NOT NULL AND finished >= claimed)),
 CHECK ((status = 'accepted' AND provider_id IS NOT NULL) OR (status <> 'accepted' AND provider_id IS NULL))
);
CREATE TRIGGER canary_no_delete BEFORE DELETE ON canary_campaign
BEGIN SELECT RAISE(ABORT, 'permanent campaign'); END;
CREATE TRIGGER canary_insert BEFORE INSERT ON canary_campaign
WHEN EXISTS (SELECT 1 FROM canary_campaign WHERE id=1) OR NEW.status <> 'previewed' OR NEW.reviewed IS NOT NULL OR NEW.approved IS NOT NULL
 OR NEW.claimed IS NOT NULL OR NEW.finished IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'invalid initialization'); END;
CREATE TRIGGER canary_immutable BEFORE UPDATE ON canary_campaign
WHEN NEW.id IS NOT OLD.id OR NEW.campaign IS NOT OLD.campaign
 OR NEW.snapshot IS NOT OLD.snapshot OR NEW.digest IS NOT OLD.digest
 OR NEW.binding IS NOT OLD.binding OR NEW.expires IS NOT OLD.expires OR NEW.created IS NOT OLD.created
 OR (OLD.reviewed IS NOT NULL AND NEW.reviewed IS NOT OLD.reviewed)
 OR (OLD.approved IS NOT NULL AND NEW.approved IS NOT OLD.approved)
 OR (OLD.claimed IS NOT NULL AND NEW.claimed IS NOT OLD.claimed)
BEGIN SELECT RAISE(ABORT, 'immutable intention'); END;
CREATE TRIGGER canary_transition BEFORE UPDATE ON canary_campaign
WHEN NOT (
 (OLD.status = 'previewed' AND NEW.status = 'reviewed' AND NEW.reviewed IS NOT NULL AND NEW.approved IS NULL AND NEW.claimed IS NULL AND NEW.finished IS NULL AND NEW.capability <> OLD.capability)
 OR (OLD.status = 'reviewed' AND NEW.status = 'approved' AND NEW.approved IS NOT NULL AND NEW.claimed IS NULL AND NEW.finished IS NULL AND NEW.capability <> OLD.capability)
 OR (OLD.status = 'approved' AND NEW.status = 'submitted' AND NEW.claimed IS NOT NULL AND NEW.finished IS NULL AND NEW.capability = OLD.capability)
 OR (OLD.status = 'submitted' AND NEW.status IN ('accepted','refused','UNKNOWN') AND NEW.finished IS NOT NULL AND NEW.capability = OLD.capability)
)
BEGIN SELECT RAISE(ABORT, 'no reset or retry'); END;
