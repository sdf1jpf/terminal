// Customer information API on Cloudflare Workers, backed by D1. The Go
// terminal's client for it is internal/api/client.go.
//
//	GET    /v1/health
//	POST   /v1/session              {"userid","password"} -> {"token",...}
//	DELETE /v1/session              log off
//	GET    /v1/customers?prefix=X   list, ordered by name
//	POST   /v1/customers            create
//	GET    /v1/customers/{id}
//	PUT    /v1/customers/{id}       update; "version" must match
//	DELETE /v1/customers/{id}

import { authenticate, checkPassword, createSession, endSession } from "./auth";
import { customerFields, parseEditable, type Customer } from "./customer";
import { errorResponse, HttpError, json, noContent, readJSON, str } from "./http";

export interface Env {
	DB: D1Database;
	CUSTAPI_USERS?: string; // secret: "USER:PASSWORD,..."
	SESSION_TTL_HOURS?: string;
}

export default {
	async fetch(req, env): Promise<Response> {
		try {
			return await route(req, env);
		} catch (e) {
			if (e instanceof HttpError) return errorResponse(e);
			console.error(e);
			return errorResponse(new HttpError(500, "internal", "internal error"));
		}
	},
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname.replace(/\/+$/, "");
	const m = req.method;

	if (path === "/v1/health") {
		if (m === "GET") return json(200, { status: "ok" });
	} else if (path === "/v1/session") {
		if (m === "POST") return logon(req, env);
		if (m === "DELETE") {
			await authenticate(env, req);
			await endSession(env, req);
			return noContent();
		}
	} else if (path === "/v1/customers") {
		if (m === "GET") {
			await authenticate(env, req);
			return list(env, url.searchParams.get("prefix") ?? "");
		}
		if (m === "POST") return create(req, env, await authenticate(env, req));
	} else if (path.startsWith("/v1/customers/") && path.split("/").length === 4) {
		const id = decodeURIComponent(path.slice("/v1/customers/".length));
		if (m === "GET") {
			await authenticate(env, req);
			return get(env, id);
		}
		if (m === "PUT") return update(req, env, await authenticate(env, req), id);
		if (m === "DELETE") {
			await authenticate(env, req);
			return remove(env, id);
		}
	} else {
		throw new HttpError(404, "not_found", "no such endpoint");
	}
	throw new HttpError(405, "method_not_allowed", `${m} is not allowed on ${path}`);
}

async function logon(req: Request, env: Env): Promise<Response> {
	const body = await readJSON(req, ["userid", "password"]);
	const userid = str(body, "userid").trim().toUpperCase();
	if (!(await checkPassword(env, userid, str(body, "password")))) {
		throw new HttpError(401, "bad_logon", "userid or password not authorized");
	}
	const { token, expiresAt } = await createSession(env, userid);
	return json(201, { token, userid, expires_at: expiresAt.toISOString() });
}

async function list(env: Env, prefix: string): Promise<Response> {
	const like = prefix.toUpperCase().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
	const { results } = await env.DB.prepare(
		"SELECT * FROM customers WHERE name LIKE ? ESCAPE '\\' ORDER BY name, id",
	).bind(like).all<Customer>();
	return json(200, results);
}

async function get(env: Env, id: string): Promise<Response> {
	const row = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first<Customer>();
	if (!row) throw notFound();
	return json(200, row);
}

async function create(req: Request, env: Env, user: string): Promise<Response> {
	const { fields: f } = parseEditable(await readJSON(req, customerFields));
	// One batch is one transaction: take the next number and insert with it.
	const [, inserted] = await env.DB.batch<Customer>([
		env.DB.prepare("UPDATE counters SET value = value + 1 WHERE name = 'customer_id'"),
		env.DB.prepare(
			`INSERT INTO customers (id, name, address, city, state, zip, phone, credit_limit, balance, status, version, updated, updated_by)
			 SELECT printf('%06d', value), ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ? FROM counters WHERE name = 'customer_id'
			 RETURNING *`,
		).bind(f.name, f.address, f.city, f.state, f.zip, f.phone, f.credit_limit, f.status, now(), user),
	]);
	return json(201, inserted.results[0]);
}

async function update(req: Request, env: Env, user: string, id: string): Promise<Response> {
	const { fields: f, version } = parseEditable(await readJSON(req, customerFields));
	const row = await env.DB.prepare(
		`UPDATE customers
		 SET name = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, credit_limit = ?, status = ?,
		     version = version + 1, updated = ?, updated_by = ?
		 WHERE id = ? AND version = ?
		 RETURNING *`,
	).bind(f.name, f.address, f.city, f.state, f.zip, f.phone, f.credit_limit, f.status, now(), user, id, version)
		.first<Customer>();
	if (row) return json(200, row);

	const exists = await env.DB.prepare("SELECT 1 FROM customers WHERE id = ?").bind(id).first();
	if (!exists) throw notFound();
	throw new HttpError(409, "conflict", "record was changed by another user");
}

async function remove(env: Env, id: string): Promise<Response> {
	const { meta } = await env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
	if (meta.changes === 0) throw notFound();
	return noContent();
}

function notFound(): HttpError {
	return new HttpError(404, "not_found", "record not found");
}

function now(): string {
	return new Date().toISOString();
}
