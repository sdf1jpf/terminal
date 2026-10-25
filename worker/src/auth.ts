// Logon sessions. Users come from the CUSTAPI_USERS secret; sessions live
// in D1 keyed by a SHA-256 of the bearer token.

import { HttpError } from "./http";
import type { Env } from "./index";

const enc = new TextEncoder();

async function sha256(s: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", enc.encode(s));
}

function hex(buf: ArrayBuffer | Uint8Array): string {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// parseUsers reads "USER:PASSWORD,USER2:PASSWORD2". Userids and passwords
// are case-insensitive, as on the mainframe.
export function parseUsers(spec: string | undefined): Map<string, string> {
	const users = new Map<string, string>();
	for (const pair of (spec ?? "").split(",")) {
		const i = pair.indexOf(":");
		if (i <= 0 || i === pair.length - 1) continue;
		users.set(pair.slice(0, i).trim().toUpperCase(), pair.slice(i + 1).trim().toUpperCase());
	}
	return users;
}

export async function checkPassword(env: Env, userid: string, password: string): Promise<boolean> {
	const users = parseUsers(env.CUSTAPI_USERS);
	if (users.size === 0) {
		throw new HttpError(500, "internal", "no users configured: set the CUSTAPI_USERS secret");
	}
	const want = users.get(userid);
	// Compare digests so the comparison is constant-time and length-independent,
	// and still do it for unknown users so timing does not reveal valid ids.
	const [a, b] = await Promise.all([sha256(want ?? crypto.randomUUID()), sha256(password.toUpperCase())]);
	return crypto.subtle.timingSafeEqual(a, b) && want !== undefined;
}

export async function createSession(env: Env, userid: string): Promise<{ token: string; expiresAt: Date }> {
	const token = hex(crypto.getRandomValues(new Uint8Array(32)));
	const hours = Number(env.SESSION_TTL_HOURS) || 8;
	const now = Date.now();
	const expiresAt = new Date(now + hours * 3_600_000);
	await env.DB.batch([
		env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
		env.DB.prepare("INSERT INTO sessions (token_hash, userid, expires_at) VALUES (?, ?, ?)")
			.bind(hex(await sha256(token)), userid, expiresAt.getTime()),
	]);
	return { token, expiresAt };
}

function bearer(req: Request): string {
	const h = req.headers.get("Authorization") ?? "";
	return h.startsWith("Bearer ") ? h.slice(7) : "";
}

// authenticate returns the logged-on userid or throws 401.
export async function authenticate(env: Env, req: Request): Promise<string> {
	const token = bearer(req);
	if (token) {
		const row = await env.DB.prepare("SELECT userid FROM sessions WHERE token_hash = ? AND expires_at > ?")
			.bind(hex(await sha256(token)), Date.now())
			.first<{ userid: string }>();
		if (row) return row.userid;
	}
	throw new HttpError(401, "unauthorized", "not logged on or session expired");
}

export async function endSession(env: Env, req: Request): Promise<void> {
	await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hex(await sha256(bearer(req)))).run();
}
