-- The print spool. Each row is an output group held on the spool: a job's
-- output listing (with the job's ID) or a report printed from a screen
-- (with a TSU ID). It stays until an operator purges it; printing sends a
-- copy to the printer and leaves it there for a reprint.
CREATE TABLE spool (
  id         TEXT PRIMARY KEY,           -- JOB00001 or TSU00001
  name       TEXT NOT NULL,              -- the job name, or the panel a report came from
  owner      TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL CHECK (status IN ('HELD', 'PRINTED')),
  lines      INTEGER NOT NULL,
  copies     INTEGER NOT NULL DEFAULT 0, -- times printed
  created    TEXT NOT NULL,              -- RFC 3339, UTC
  printed    TEXT NOT NULL DEFAULT '',   -- the last time it was printed
  printed_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX spool_by_created ON spool (created);

CREATE TABLE spool_lines (
  spool_id TEXT NOT NULL,
  line     INTEGER NOT NULL,
  text     TEXT NOT NULL,
  PRIMARY KEY (spool_id, line)
);

INSERT INTO counters (name, value) VALUES ('tsu_id', 0);

-- Job output listings move onto the spool.
INSERT INTO spool (id, name, owner, title, status, lines, created)
  SELECT j.id, j.name, j.submitted_by, '', 'HELD',
         (SELECT COUNT(*) FROM job_output o WHERE o.job_id = j.id), CASE j.ended WHEN '' THEN j.submitted ELSE j.ended END
  FROM jobs j WHERE j.status = 'OUTPUT';
INSERT INTO spool_lines (spool_id, line, text) SELECT job_id, line, text FROM job_output;
UPDATE spool SET title = CASE name
  WHEN 'CUSAGING' THEN 'AGED BALANCES REPORT'
  WHEN 'CUSCRREV' THEN 'CREDIT REVIEW - HOLD ACCOUNTS OVER LIMIT'
  WHEN 'CUSSTMT' THEN 'CUSTOMER STATEMENTS'
  WHEN 'EDISIM' THEN 'EDI TRADING PARTNER SIMULATOR'
  ELSE '' END;
DROP TABLE job_output;
