-- CICS-style transactions (src/cics.ts). A row exists once a transaction
-- has been used or set; transactions without one are enabled and unused.
CREATE TABLE cics_transactions (
	tranid TEXT PRIMARY KEY,
	status TEXT NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED', 'DISABLED')),
	uses INTEGER NOT NULL DEFAULT 0,
	abends INTEGER NOT NULL DEFAULT 0,
	last_used TEXT,
	last_abend TEXT -- the abend code, such as ASRA
);

-- Terminals in EDF mode (CEDF): each screen step stops on the CEDF panel.
CREATE TABLE cics_edf (
	user TEXT NOT NULL,
	terminal TEXT NOT NULL,
	since TEXT NOT NULL,
	PRIMARY KEY (user, terminal)
);

-- Temporary storage queues, browsed with CEBR. CSMT holds the abend log
-- and CEDFtttt each terminal's EDF trace.
CREATE TABLE cics_tsq (
	queue TEXT NOT NULL,
	item INTEGER NOT NULL,
	data TEXT NOT NULL,
	written TEXT NOT NULL,
	PRIMARY KEY (queue, item)
);

INSERT INTO counters (name, value) VALUES ('cics_task', 0);
