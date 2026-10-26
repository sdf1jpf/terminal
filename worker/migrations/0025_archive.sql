-- The archive: output moved off the spool, and documents the batch jobs
-- write (statements, dunning letters, month-end reports), kept as files in
-- R2 (the customer-archive bucket). Each entry is two objects: <key>.txt,
-- the lines as they were on the spool, and <key>.pdf, the printed copy.
CREATE TABLE archive (
  key          TEXT PRIMARY KEY,           -- spool/2026-10/JOB00012, statements/2026-10/000101
  kind         TEXT NOT NULL CHECK (kind IN ('L', 'M', 'S', 'D')),  -- listing, month-end report, statement, dunning letter
  ref          TEXT NOT NULL,              -- the output group, customer or period it is for
  name         TEXT NOT NULL,              -- the job, or the panel a report came from
  title        TEXT NOT NULL DEFAULT '',
  owner        TEXT NOT NULL,
  lines        INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,           -- the PDF's size
  created      TEXT NOT NULL,              -- when the output was made, RFC 3339, UTC
  archived     TEXT NOT NULL,
  archived_by  TEXT NOT NULL
);
CREATE INDEX archive_by_archived ON archive (archived);
CREATE INDEX archive_by_ref ON archive (ref);

-- Every morning, before the nightly run, output more than a week old moves
-- off the spool into the archive.
INSERT INTO schedules (name, cron, enabled, updated, updated_by) VALUES
  ('CUSARCH', '0 5 * * *', 1, '2026-10-26T00:00:00Z', 'IBMUSER');
