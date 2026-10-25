-- Batch jobs, JES style. Submitting a job puts it on the customer-jobs
-- queue; the queue's consumer starts a JobRunner workflow for it, which
-- runs the job's steps and writes their output here.
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,           -- JOB00001
  name         TEXT NOT NULL,              -- e.g. CUSAGING
  status       TEXT NOT NULL CHECK (status IN ('QUEUED', 'EXECUTING', 'OUTPUT')),
  rc           TEXT NOT NULL DEFAULT '',   -- highest condition code, e.g. 0004, or ABEND
  submitted    TEXT NOT NULL,              -- RFC 3339, UTC
  submitted_by TEXT NOT NULL,
  started      TEXT NOT NULL DEFAULT '',
  ended        TEXT NOT NULL DEFAULT ''
);

-- The job's output listing (its SYSOUT), one row per line.
CREATE TABLE job_output (
  job_id TEXT NOT NULL,
  line   INTEGER NOT NULL,
  text   TEXT NOT NULL,
  PRIMARY KEY (job_id, line)
);

INSERT INTO counters (name, value) VALUES ('job_id', 0);
