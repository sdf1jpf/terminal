// Customer information API on Cloudflare Workers, backed by D1. The Go
// terminal's client for it is internal/api/client.go.
//
//	GET    /v1/health
//	POST   /v1/session              logon: -> {"userid"}
//	GET    /v1/customers?prefix=X   list, ordered by name
//	POST   /v1/customers            create
//	GET    /v1/customers/{id}
//	PUT    /v1/customers/{id}       update; "version" must match
//	DELETE /v1/customers/{id}
//	GET    /v1/customers/{id}/transactions   activity, newest first
//	POST   /v1/customers/{id}/transactions   post an invoice or payment
//	GET    /v1/customers/{id}/history        change history, newest first
//
// Everything except health is behind Cloudflare Access; see auth.ts.

import { customerHistory, diff, listTransactions, parsePosting, postTransaction, transactionFields } from "./activity";
import { authenticate } from "./auth";
import { customerFields, parseEditable, type Customer } from "./customer";
import { errorResponse, HttpError, json, noContent, readJSON } from "./http";

export interface Env {
	DB: D1Database;
	ACCESS_TEAM_DOMAIN?: string; // e.g. "example.cloudflareaccess.com"
	ACCESS_AUD?: string; // the Access application's audience tag
	DEV_USER?: string; // wrangler dev only, when Access is not configured
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
		if (m === "POST") return json(201, { userid: await authenticate(env, req) });
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
		if (m === "DELETE") return remove(env, await authenticate(env, req), id);
	} else if (path.startsWith("/v1/customers/") && path.split("/").length === 5) {
		const [, , , rawId, sub] = path.split("/");
		const id = decodeURIComponent(rawId);
		if (sub === "transactions") {
			if (m === "GET") {
				await authenticate(env, req);
				return transactions(env, id);
			}
			if (m === "POST") return post(req, env, await authenticate(env, req), id);
		} else if (sub === "history") {
			if (m === "GET") {
				await authenticate(env, req);
				return history(env, id);
			}
		} else {
			throw new HttpError(404, "not_found", "no such endpoint");
		}
	} else {
		throw new HttpError(404, "not_found", "no such endpoint");
	}
	throw new HttpError(405, "method_not_allowed", `${m} is not allowed on ${path}`);
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
	const ts = now();
	const [, inserted] = await env.DB.batch<Customer>([
		env.DB.prepare("UPDATE counters SET value = value + 1 WHERE name = 'customer_id'"),
		env.DB.prepare(
			`INSERT INTO customers (id, name, address, city, state, zip, phone, credit_limit, balance, status, version, updated, updated_by)
			 SELECT printf('%06d', value), ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ? FROM counters WHERE name = 'customer_id'
			 RETURNING *`,
		).bind(f.name, f.address, f.city, f.state, f.zip, f.phone, f.credit_limit, f.status, ts, user),
		env.DB.prepare(
			"INSERT INTO audit (customer_id, action, at, by) SELECT printf('%06d', value), 'ADD', ?, ? FROM counters WHERE name = 'customer_id'",
		).bind(ts, user),
	]);
	return json(201, inserted.results[0]);
}

async function update(req: Request, env: Env, user: string, id: string): Promise<Response> {
	const { fields: f, version } = parseEditable(await readJSON(req, customerFields));
	const before = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first<Customer>();
	if (!before) throw notFound();
	if (before.version !== version) throw conflict();

	// The history rows and the update share a condition and a batch, so they
	// land together or not at all. Versions only go up, so a record still at
	// the version read above still holds what was read.
	const ts = now();
	const audits = diff(before, f).map((d) =>
		env.DB.prepare(
			`INSERT INTO audit (customer_id, action, field, old_value, new_value, at, by)
			 SELECT ?, 'CHANGE', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM customers WHERE id = ? AND version = ?)`,
		).bind(id, d.field, d.from, d.to, ts, user, id, version),
	);
	const results = await env.DB.batch<Customer>([
		...audits,
		env.DB.prepare(
			`UPDATE customers
			 SET name = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, credit_limit = ?, status = ?,
			     version = version + 1, updated = ?, updated_by = ?
			 WHERE id = ? AND version = ?
			 RETURNING *`,
		).bind(f.name, f.address, f.city, f.state, f.zip, f.phone, f.credit_limit, f.status, ts, user, id, version),
	]);
	const row = results[results.length - 1].results[0];
	if (row) return json(200, row);

	const exists = await env.DB.prepare("SELECT 1 FROM customers WHERE id = ?").bind(id).first();
	if (!exists) throw notFound();
	throw conflict();
}

async function remove(env: Env, user: string, id: string): Promise<Response> {
	const [, , deleted] = await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO audit (customer_id, action, at, by) SELECT id, 'DELETE', ?, ? FROM customers WHERE id = ?",
		).bind(now(), user, id),
		env.DB.prepare("DELETE FROM transactions WHERE customer_id = ?").bind(id),
		env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(id),
	]);
	if (deleted.meta.changes === 0) throw notFound();
	return noContent();
}

async function transactions(env: Env, id: string): Promise<Response> {
	const list = await listTransactions(env.DB, id);
	if (!list) throw notFound();
	return json(200, list);
}

async function post(req: Request, env: Env, user: string, id: string): Promise<Response> {
	return json(201, await postTransaction(env.DB, user, id, parsePosting(await readJSON(req, transactionFields))));
}

async function history(env: Env, id: string): Promise<Response> {
	return json(200, await customerHistory(env.DB, id));
}

function notFound(): HttpError {
	return new HttpError(404, "not_found", "record not found");
}

function conflict(): HttpError {
	return new HttpError(409, "conflict", "record was changed by another user");
}

function now(): string {
	return new Date().toISOString();
}
