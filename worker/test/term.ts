// Terminal plays the part of a 3270 client in tests of POST /v1/screen.
import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import { accessJWT } from "./access";

export const worker = (exports as unknown as { default: Fetcher }).default;

interface Field {
	row: number; col: number; text?: string; name?: string; length?: number; value?: string;
	color?: string; bright?: boolean; numeric?: boolean; modified?: boolean;
}
interface Screen { map: string; rows: number; cols: number; fields: Field[]; cursor?: { field?: string; row?: number; col?: number } }

export async function post(body: unknown, token?: string) {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token) headers["Cf-Access-Jwt-Assertion"] = token;
	const res = await worker.fetch("https://api.test/v1/screen", { method: "POST", headers, body: JSON.stringify(body) });
	return { status: res.status, body: await res.json<any>() };
}

// Terminal plays the part of the Go client: it keeps the commarea, lets the
// test type into fields, and sends AID keys.
export class Terminal {
	state = "";
	scr!: Screen;
	vals: Record<string, string> = {};
	modified = new Set<string>();
	cursorField = ""; // the field the cursor is in, sent with the next key
	logoff = "";
	download?: { url: string; name: string }; // a file sent with the last screen

	live = false; // say the client listens on GET /v1/live

	constructor(readonly token: string, public rows = 24, public cols = 80, readonly terminal = "TERM0001") {}

	static async logon(rows = 24, cols = 80) {
		const t = new Terminal(await accessJWT(), rows, cols);
		await t.send("START");
		return t;
	}

	// as logs on another user, by the local part of their email, or the
	// same user on another terminal.
	static async as(user: string, terminal = "TERM0002") {
		const t = new Terminal(await accessJWT({ email: `${user.toLowerCase()}@example.com` }), 24, 80, terminal);
		await t.send("START");
		return t;
	}

	async send(aid: string) {
		const res = await post({
			v: 1, aid, state: aid === "START" ? undefined : this.state, fields: this.vals,
			modified: [...this.modified], cursor: { row: 1, col: 1, field: this.cursorField },
			rows: this.rows, cols: this.cols, terminal: this.terminal, system: "TEST", ...(this.live ? { live: true } : {}),
		}, this.token);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		if (res.body.logoff) {
			this.logoff = res.body.logoff.message;
			return this;
		}
		this.state = res.body.state;
		this.scr = res.body.screen;
		this.download = res.body.download;
		this.vals = {};
		this.modified.clear();
		this.cursorField = "";
		for (const f of this.scr.fields) {
			if (f.name) this.vals[f.name] = f.value ?? "";
			if (f.name && f.modified) this.modified.add(f.name);
		}
		return this;
	}

	fill(...kv: string[]) {
		for (let i = 0; i < kv.length; i += 2) {
			const f = this.scr.fields.find((f) => f.name === kv[i]);
			expect(f, `field ${kv[i]}`).toBeDefined();
			this.vals[kv[i]] = kv[i + 1].toUpperCase();
			this.modified.add(kv[i]);
		}
		return this;
	}

	field(name: string) {
		return this.scr.fields.find((f) => f.name === name);
	}

	// row renders one row of the screen as text.
	row(n: number): string {
		const line = Array(this.scr.cols).fill(" ");
		for (const f of this.scr.fields) {
			if (f.row !== n) continue;
			const s = f.text ?? (f.value ?? "").padEnd(f.length ?? 0);
			for (let i = 0; i < s.length && f.col - 1 + i < line.length; i++) line[f.col - 1 + i] = s[i];
		}
		return line.join("");
	}

	get message() {
		return this.row(this.scr.rows - 1).trim();
	}
}

