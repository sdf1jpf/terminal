// The TSO address space: one Durable Object that knows who is signed on,
// which records they hold for update, and the messages users SEND each
// other. It also keeps the terminals' WebSocket connections (GET /v1/live)
// and pushes them an event when something they show has changed, so the
// operator console follows SYSLOG without every terminal polling for it.
//
// The screens stay pseudo-conversational: each POST /v1/screen calls sync
// once with the records its next panel needs locked (screens/index.ts).
// Everything lives in the object's own SQLite storage, and every method
// runs without awaiting, so each is atomic.

import { DurableObject } from "cloudflare:workers";
import { HttpError } from "./http";
import type { Env } from "./index";

// A session that has not been seen for this long has ended (TSO's idle
// limit, S522); its locks go with it.
export const IDLE_MS = 30 * 60_000;
// The console watcher checks SYSLOG this often while a terminal listens.
const WATCH_MS = 1_000;
// Undelivered messages per user, and how long they wait.
const MAX_PENDING = 50;
const KEEP_MESSAGES_MS = 7 * 86_400_000;

export type Holder = {
	resource: string; // e.g. "CUSTOMER 000101"
	sid: string;
	user: string;
	terminal: string;
	since: string; // RFC 3339
};

export interface TsoSession {
	sid: string; // TSU00042
	user: string;
	terminal: string;
	logon: string; // RFC 3339
	seen: string;
	map: string; // the panel it last showed
}

export interface Message {
	from: string;
	text: string;
	sent: string; // RFC 3339
}

export interface SyncResult {
	sid: string; // the session, renewed if it had ended
	conflict?: Holder; // a lock another session holds: nothing changed
	message?: Message; // the oldest undelivered message, now delivered
}

export interface SendResult {
	sent: string[]; // users it was sent or saved for
	notOn: string[]; // users not signed on, without LOGON
}

// Push events, as JSON text on the WebSocket.
export type LiveEvent = { event: "syslog"; seq: number } | { event: "message" };

export class Sessions extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				sid TEXT PRIMARY KEY, user TEXT NOT NULL, terminal TEXT NOT NULL,
				logon TEXT NOT NULL, seen INTEGER NOT NULL, map TEXT NOT NULL DEFAULT '');
			CREATE TABLE IF NOT EXISTS locks (resource TEXT PRIMARY KEY, sid TEXT NOT NULL, since TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT, to_user TEXT NOT NULL, from_user TEXT NOT NULL,
				text TEXT NOT NULL, sent INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
		`);
		// A client's keepalive is answered without waking the object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	// logon starts a session and returns its TSU id.
	logon(user: string, terminal: string): string {
		this.expire();
		return this.create(user, terminal);
	}

	// logoff ends a session and releases its locks.
	logoff(sid: string, user: string): void {
		this.sql.exec("DELETE FROM locks WHERE sid IN (SELECT sid FROM sessions WHERE sid = ? AND user = ?)", sid, user);
		this.sql.exec("DELETE FROM sessions WHERE sid = ? AND user = ?", sid, user);
	}

	// sync records that the session is showing map and holds exactly the
	// locks in want: missing ones are taken and the rest released. If
	// another session holds one of them, nothing changes and the holder
	// comes back as the conflict. It also delivers one waiting message.
	sync(sid: string, user: string, terminal: string, map: string, want: string[]): SyncResult {
		this.expire();
		sid = this.touch(sid, user, terminal, map);
		const out: SyncResult = { sid };
		const conflict = this.conflict(sid, want);
		if (conflict) out.conflict = conflict;
		else {
			const keep = new Set(want);
			for (const { resource } of this.sql.exec<{ resource: string }>("SELECT resource FROM locks WHERE sid = ?", sid)) {
				if (!keep.has(resource)) this.sql.exec("DELETE FROM locks WHERE resource = ?", resource);
			}
			this.take(sid, want);
		}
		const msg = this.sql.exec<{ id: number; from_user: string; text: string; sent: number }>(
			"SELECT * FROM messages WHERE to_user = ? ORDER BY id LIMIT 1", user,
		).toArray()[0];
		if (msg) {
			this.sql.exec("DELETE FROM messages WHERE id = ?", msg.id);
			out.message = { from: msg.from_user, text: msg.text, sent: new Date(msg.sent).toISOString() };
		}
		return out;
	}

	// hold makes sure the session still holds the locks in want, taking any
	// that lapsed, before a panel acts on them. lost is set when another
	// session has one now.
	hold(sid: string, user: string, terminal: string, want: string[]): { sid: string; lost?: Holder } {
		this.expire();
		sid = this.touch(sid, user, terminal);
		const lost = this.conflict(sid, want);
		if (lost) return { sid, lost };
		this.take(sid, want);
		return { sid };
	}

	// holder returns who holds resource, if anyone.
	holder(resource: string): Holder | null {
		this.expire();
		return this.sql.exec<Holder>(
			"SELECT l.resource, l.sid, s.user, s.terminal, l.since FROM locks l JOIN sessions s USING (sid) WHERE l.resource = ?",
			resource,
		).toArray()[0] ?? null;
	}

	// users lists the signed-on sessions, by userid.
	users(): TsoSession[] {
		this.expire();
		return this.sql.exec<Omit<TsoSession, "seen"> & { seen: number }>(
			"SELECT sid, user, terminal, logon, seen, map FROM sessions ORDER BY user, sid",
		).toArray().map((s) => ({ ...s, seen: new Date(s.seen).toISOString() }));
	}

	// locks lists the locks held, by resource.
	locks(): Holder[] {
		this.expire();
		return this.sql.exec<Holder>(
			"SELECT l.resource, l.sid, s.user, s.terminal, l.since FROM locks l JOIN sessions s USING (sid) ORDER BY l.resource",
		).toArray();
	}

	// send queues text for each user in to, or for every signed-on user but
	// the sender when to is ["*"]. A user who is not signed on gets it only
	// with logon, at their next logon, as TSO's SEND ... LOGON does.
	send(from: string, to: string[], text: string, logon: boolean): SendResult {
		this.expire();
		const on = new Set(this.sql.exec<{ user: string }>("SELECT DISTINCT user FROM sessions").toArray().map((r) => r.user));
		const targets = to.includes("*") ? [...on].filter((u) => u !== from) : [...new Set(to)];
		const out: SendResult = { sent: [], notOn: [] };
		const now = Date.now();
		for (const user of targets) {
			if (!on.has(user) && !logon) {
				out.notOn.push(user);
				continue;
			}
			this.sql.exec("INSERT INTO messages (to_user, from_user, text, sent) VALUES (?, ?, ?, ?)", user, from, text, now);
			this.sql.exec(
				"DELETE FROM messages WHERE to_user = ? AND id NOT IN (SELECT id FROM messages WHERE to_user = ? ORDER BY id DESC LIMIT ?)",
				user, user, MAX_PENDING,
			);
			out.sent.push(user);
			this.push({ event: "message" }, user);
		}
		return out;
	}

	// fetch accepts a terminal's WebSocket. The Worker has signed the user
	// on and passes the userid in a header.
	async fetch(req: Request): Promise<Response> {
		const user = req.headers.get(USER_HEADER);
		if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket" || !user) {
			return new Response("expected a WebSocket upgrade", { status: 426 });
		}
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, [user]);
		const waiting = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE to_user = ?", user).one().n;
		if (waiting > 0) server.send(JSON.stringify({ event: "message" } satisfies LiveEvent));
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + WATCH_MS);
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(): void {} // clients only send keepalives, answered above

	webSocketClose(ws: WebSocket, code: number): void {
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code);
		} catch {
			// already closed
		}
	}

	// alarm is the console watcher: while any terminal listens, it looks at
	// the end of SYSLOG every second and tells them when it moves. Every
	// writer of the log (jobs, the scheduler, commands, logons) is covered
	// without having to call in.
	async alarm(): Promise<void> {
		if (this.ctx.getWebSockets().length === 0) return; // stop until the next terminal connects
		try {
			const row = await this.env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM syslog").first<{ seq: number }>();
			const seq = row?.seq ?? 0;
			const last = this.counter("syslog");
			if (seq !== last) {
				this.setCounter("syslog", seq);
				if (last !== 0) this.push({ event: "syslog", seq });
			}
		} finally {
			await this.ctx.storage.setAlarm(Date.now() + WATCH_MS);
		}
	}

	// push sends an event to user's terminals, or to all of them.
	private push(e: LiveEvent, user?: string): void {
		const text = JSON.stringify(e);
		for (const ws of this.ctx.getWebSockets(user)) {
			try {
				ws.send(text);
			} catch {
				// closing; it will be gone on the next push
			}
		}
	}

	// expire ends sessions idle longer than IDLE_MS, with their locks, and
	// drops old undelivered messages.
	private expire(): void {
		const now = Date.now();
		this.sql.exec("DELETE FROM sessions WHERE seen < ?", now - IDLE_MS);
		this.sql.exec("DELETE FROM locks WHERE sid NOT IN (SELECT sid FROM sessions)");
		this.sql.exec("DELETE FROM messages WHERE sent < ?", now - KEEP_MESSAGES_MS);
	}

	private create(user: string, terminal: string, map = ""): string {
		const n = this.counter("tsu") % 99_999 + 1;
		this.setCounter("tsu", n);
		const sid = `TSU${String(n).padStart(5, "0")}`;
		const now = Date.now();
		this.sql.exec("INSERT OR REPLACE INTO sessions (sid, user, terminal, logon, seen, map) VALUES (?, ?, ?, ?, ?, ?)",
			sid, user, terminal, new Date(now).toISOString(), now, map);
		return sid;
	}

	// touch marks the session as seen and returns its sid, or starts a new
	// one when it has ended, never existed (a commarea from before
	// sessions), or belongs to someone else.
	private touch(sid: string, user: string, terminal: string, map?: string): string {
		const own = sid !== "" && this.sql.exec("SELECT 1 FROM sessions WHERE sid = ? AND user = ?", sid, user).toArray().length > 0;
		if (!own) return this.create(user, terminal, map);
		this.sql.exec("UPDATE sessions SET seen = ?, terminal = ?, map = COALESCE(?, map) WHERE sid = ?",
			Date.now(), terminal, map ?? null, sid);
		return sid;
	}

	private conflict(sid: string, want: string[]): Holder | undefined {
		for (const resource of want) {
			const h = this.holder(resource);
			if (h && h.sid !== sid) return h;
		}
		return undefined;
	}

	private take(sid: string, want: string[]): void {
		const since = new Date().toISOString();
		for (const resource of want) this.sql.exec("INSERT OR IGNORE INTO locks (resource, sid, since) VALUES (?, ?, ?)", resource, sid, since);
	}

	private counter(name: string): number {
		return this.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name = ?", name).toArray()[0]?.value ?? 0;
	}

	private setCounter(name: string, value: number): void {
		this.sql.exec("INSERT OR REPLACE INTO counters (name, value) VALUES (?, ?)", name, value);
	}
}

export const USER_HEADER = "X-TSO-User";

// tso returns the system's one Sessions object.
export function tso(env: { SESSIONS: DurableObjectNamespace<Sessions> }): DurableObjectStub<Sessions> {
	return env.SESSIONS.get(env.SESSIONS.idFromName("TSO"));
}

// notLocked refuses a change to resource made outside the terminal (the
// REST API) while another user has it locked for update in one.
export async function notLocked(env: { SESSIONS: DurableObjectNamespace<Sessions> }, resource: string, user: string): Promise<void> {
	const h = await tso(env).holder(resource);
	if (h && h.user !== user) {
		throw new HttpError(423, "locked", `record in use by ${h.user} on ${h.terminal}`);
	}
}
