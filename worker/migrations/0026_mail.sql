-- The mail log: statements and dunning letters mailed (one row per attempt;
-- each archived document is sent once), and mail received from vendors.
CREATE TABLE mail (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  direction    TEXT NOT NULL CHECK (direction IN ('O', 'I')),  -- out, in
  status       TEXT NOT NULL CHECK (status IN ('SENT', 'FAILED', 'APPLIED', 'REJECTED')),
  sender       TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  subject      TEXT NOT NULL,
  ref          TEXT NOT NULL DEFAULT '',   -- the customer or purchase order
  archive_key  TEXT NOT NULL DEFAULT '',   -- the document attached
  message_id   TEXT NOT NULL DEFAULT '',
  detail       TEXT NOT NULL DEFAULT '',   -- an error, or what an inbound message did
  at           TEXT NOT NULL,              -- RFC 3339, UTC
  by           TEXT NOT NULL
);
CREATE INDEX mail_by_ref ON mail (ref, seq);
CREATE INDEX mail_by_archive_key ON mail (archive_key);
