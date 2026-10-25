// POST /v1/screen: the terminal's screens, served by the Worker. The
// protocol is described in docs/screen-protocol.md. A client sends the AID
// key, its input fields and the commarea from the last reply; this module
// runs the panel the commarea names and answers with the next screen.

import type { Env } from "../index";
import { HttpError, int, str } from "../http";
import { activity, event, history } from "./activity";
import { browse } from "./browse";
import { detail } from "./detail";
import { fieldHelp } from "./fieldhelp";
import { help } from "./help";
import { invoice, invoices } from "./invoices";
import { joblog, jobs } from "./jobs";
import { product, products } from "./products";
import { menu } from "./menu";
import { report } from "./report";
import { MIN_COLS, MIN_ROWS, time, type Ctx, type Screen } from "./screen";
import type { Input, Next, Program, State } from "./program";

export const requestKeys = [
	"v", "aid", "state", "fields", "modified", "cursor", "rows", "cols", "terminal", "system", "tz_offset",
] as const;

const programs: { [P in State["p"]]: Program<Extract<State, { p: P }>> } = {
	menu, browse, detail, report, help, activity, event, history, jobs, joblog, products, product, invoices, invoice,
};

// The commarea's own version. Bump it when a state shape changes in a way
// old states cannot be read; clients holding an old one go back to the menu.
const STATE_VERSION = 1;

const MAX_ROWS = 200;
const MAX_COLS = 400;

const aids = new Set([
	"ENTER", "CLEAR", "PA1", "PA2", "PA3",
	...Array.from({ length: 24 }, (_, i) => `PF${i + 1}`),
]);

export type ScreenResponse =
	| { v: 1; state: string; screen: ReturnType<Screen["toJSON"]> }
	| { v: 1; logoff: { message: string } };

export async function screen(env: Env, user: string, url: URL, body: Record<string, unknown>): Promise<ScreenResponse> {
	if (body.v !== 1) throw bad('"v" must be 1');
	const aid = str(body, "aid");
	const ctx: Ctx = {
		db: env.DB,
		jobs: env.JOBS,
		user,
		rows: clamp(int(body, "rows"), MIN_ROWS, MAX_ROWS),
		cols: clamp(int(body, "cols"), MIN_COLS, MAX_COLS),
		system: str(body, "system") || "SYS1",
		terminal: str(body, "terminal") || "TERM0001",
		host: url.host,
		tzOffset: clamp(int(body, "tz_offset"), -14 * 60, 14 * 60),
	};

	let next: Next;
	if (aid === "START") {
		next = { p: "menu", msg: `IKJ56455I ${user} LOGON IN PROGRESS AT ${time(ctx)}` };
	} else {
		const current = decode(str(body, "state"));
		if (!current) {
			next = { p: "menu", msg: "CUS0001W SCREEN STATE LOST OR FROM AN OLDER RELEASE - BACK AT MENU" };
		} else if (aid === "REDRAW") {
			next = current;
		} else if (!aids.has(aid)) {
			throw bad(`unknown aid "${aid}"`);
		} else if (aid === "PF1" && current.p !== "help") {
			// PF1 is help on every screen: for the field the cursor is in if
			// it has any, otherwise the tutorial.
			const field = input(body, aid).cursorField;
			next = fieldHelp(current, field) ? { p: "help", back: current, field } : { p: "help", back: current };
		} else {
			next = await (programs[current.p] as Program<State>).handle(ctx, current, input(body, aid));
		}
	}

	if ("logoff" in next) return { v: 1, logoff: { message: next.logoff } };
	const scr = await (programs[next.p] as Program<State>).render(ctx, next);
	return { v: 1, state: encode(next), screen: scr.toJSON() };
}

function input(body: Record<string, unknown>, aid: string): Input {
	const fields: Record<string, string> = {};
	const raw = body.fields ?? {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad('"fields" must be an object');
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v !== "string") throw bad(`field "${k}" must be a string`);
		fields[k] = v;
	}
	const modified = body.modified ?? [];
	if (!Array.isArray(modified) || modified.some((m) => typeof m !== "string")) {
		throw bad('"modified" must be a list of field names');
	}
	const cursor = body.cursor;
	const cursorField = typeof cursor === "object" && cursor !== null && "field" in cursor && typeof cursor.field === "string"
		? cursor.field : "";
	return { aid, fields, modified: new Set(modified as string[]), cursorField };
}

function encode(s: State): string {
	return JSON.stringify({ sv: STATE_VERSION, s });
}

// decode reads a commarea, or returns undefined if it is missing, damaged
// or from an incompatible release.
function decode(raw: string): State | undefined {
	try {
		const { sv, s } = JSON.parse(raw);
		if (sv === STATE_VERSION && valid(s)) return s;
	} catch {
		// fall through
	}
	return undefined;
}

function valid(s: unknown, depth = 0): s is State {
	if (typeof s !== "object" || s === null || depth > 8) return false;
	const st = s as { p?: unknown; back?: unknown };
	if (typeof st.p !== "string" || !Object.hasOwn(programs, st.p)) return false;
	return st.back === undefined || valid(st.back, depth + 1);
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(Math.max(n, lo), hi);
}

function bad(msg: string): HttpError {
	return new HttpError(400, "bad_request", "invalid request body: " + msg);
}
