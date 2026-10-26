// The screen builder and layout helpers come from greenscreen; see its
// docs/protocol.md for the wire format. Ctx adds what this system's panels
// use on every request.

import type { Ctx as ScreenCtx } from "@greenscreen-dev/worker";
import type { Env } from "../index";
import type { JobMessage } from "../jobs";
import type { Sessions } from "../sessions";

export {
	breakIn, center, clock, date, dots, header, keys, label, lpad, message, money, newScreen, pad, right, stamp, textLines,
	time, value, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS, Screen,
	type Color, type Cursor, type Field, type Highlight, type Opts,
} from "@greenscreen-dev/worker";

// Ctx is what a panel knows about the request it is answering: greenscreen's
// own, plus this system's bindings by name (screens/index.ts context).
export interface Ctx extends ScreenCtx<Env> {
	db: D1Database;
	tables: KVNamespace; // the system tables
	jobs: Queue<JobMessage>; // the batch job input queue
	tso: DurableObjectStub<Sessions>; // sessions, locks and messages
}

export function invalidKey(aid: string): string {
	return `CUS0000W ${aid} IS NOT ACTIVE ON THIS SCREEN`;
}
