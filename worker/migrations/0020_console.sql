-- The operator console. SYSLOG is the system log: job and scheduler
-- messages, logons, and operator commands with their responses, in the
-- order they happened.
CREATE TABLE syslog (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,              -- RFC 3339, UTC
  source  TEXT NOT NULL,              -- a job ID, userid, or SCHEDULR
  type    TEXT NOT NULL DEFAULT 'M' CHECK (type IN ('M', 'C', 'R')),  -- message, command, response
  text    TEXT NOT NULL
);

-- The job scheduler. A Worker cron trigger runs every minute and submits
-- each enabled job whose cron expression (in UTC) matches that minute.
CREATE TABLE schedules (
  name       TEXT PRIMARY KEY,           -- a job in the job library
  cron       TEXT NOT NULL,              -- minute hour day month weekday
  enabled    INTEGER NOT NULL DEFAULT 1,
  last_due   TEXT NOT NULL DEFAULT '',   -- the minute it last ran for, RFC 3339
  last_job   TEXT NOT NULL DEFAULT '',   -- the job it submitted then
  updated    TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- The nightly run, at 1-2 AM US Eastern. The EDI simulator is there to
-- release by hand.
INSERT INTO schedules (name, cron, enabled, updated, updated_by) VALUES
  ('CUSCRREV', '0 6 * * *', 1, '2026-10-25T00:00:00Z', 'IBMUSER'),
  ('CUSAGING', '15 6 * * *', 1, '2026-10-25T00:00:00Z', 'IBMUSER'),
  ('CUSSTMT', '30 6 * * *', 1, '2026-10-25T00:00:00Z', 'IBMUSER'),
  ('EDISIM', '0 * * * *', 0, '2026-10-25T00:00:00Z', 'IBMUSER');
