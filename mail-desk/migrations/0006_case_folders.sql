-- Additive storage: cases positional INSERT writers remain compatible. No retention.
CREATE TABLE case_folders (
 case_id TEXT PRIMARY KEY REFERENCES cases(id),
 folder TEXT NOT NULL DEFAULT 'inbox' CHECK(folder IN ('inbox','archive','trash')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 updated_at INTEGER NOT NULL,
 invalidated_revision INTEGER NOT NULL DEFAULT -1
);
CREATE INDEX case_folders_queue ON case_folders(folder,updated_at);
CREATE TABLE case_folder_sync (
 case_id TEXT PRIMARY KEY REFERENCES case_folders(case_id),
 synced_version INTEGER NOT NULL DEFAULT -1,
 next_attempt INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO case_folders(case_id,updated_at) SELECT id,updated_at FROM cases;
INSERT INTO case_folder_sync(case_id) SELECT id FROM cases;
CREATE TRIGGER case_folder_initial AFTER INSERT ON cases BEGIN
 INSERT INTO case_folders(case_id,updated_at) VALUES(NEW.id,NEW.updated_at);
 INSERT INTO case_folder_sync(case_id) VALUES(NEW.id);
END;
CREATE TRIGGER case_folder_transition BEFORE UPDATE ON case_folders
 WHEN NEW.case_id<>OLD.case_id OR NEW.folder=OLD.folder OR NEW.version<>OLD.version+1
 OR NEW.invalidated_revision<>(SELECT revision+1 FROM cases WHERE id=OLD.case_id)
 BEGIN SELECT RAISE(ABORT,'invalid_folder_transition'); END;
CREATE TRIGGER case_folder_changed AFTER UPDATE ON case_folders BEGIN
 UPDATE cases SET revision=NEW.invalidated_revision,updated_at=NEW.updated_at WHERE id=NEW.case_id;
 UPDATE case_folder_sync SET next_attempt=0 WHERE case_id=NEW.case_id;
 INSERT INTO audit_events VALUES(lower(hex(randomblob(16))),'folder_'||NEW.folder,NEW.case_id,NULL,NEW.updated_at);
END;
