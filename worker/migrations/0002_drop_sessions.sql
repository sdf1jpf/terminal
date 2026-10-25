-- Logon moved to Cloudflare Access, which carries the identity on every
-- request, so the Worker no longer keeps its own sessions.
DROP TABLE sessions;
