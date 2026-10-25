// Customer information API on Cloudflare Workers, backed by D1. The Go
// terminal's client for it is internal/api/client.go.
//
//	GET    /v1/health
//	POST   /v1/session              logon: -> {"userid"}
//	POST   /v1/screen               the terminal's screens; see docs/screen-protocol.md
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

import { customerHistory, listTransactions, parsePosting, postTransaction, transactionFields } from "./activity";
import { authenticate } from "./auth";
import { customerFields, parseEditable } from "./customer";
import { createCustomer, deleteCustomer, getCustomer, listCustomers, notFound, updateCustomer } from "./data";
import { errorResponse, HttpError, json, noContent, readJSON } from "./http";
import { requestKeys, screen } from "./screens";

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
	} else if (path === "/v1/screen") {
		if (m === "POST") return json(200, await screen(env, await authenticate(env, req), url, await readJSON(req, requestKeys)));
	} else if (path === "/v1/customers") {
		if (m === "GET") {
			await authenticate(env, req);
			return json(200, await listCustomers(env.DB, url.searchParams.get("prefix") ?? ""));
		}
		if (m === "POST") return create(req, env, await authenticate(env, req));
	} else if (path.startsWith("/v1/customers/") && path.split("/").length === 4) {
		const id = decodeURIComponent(path.slice("/v1/customers/".length));
		if (m === "GET") {
			await authenticate(env, req);
			return json(200, await getCustomer(env.DB, id));
		}
		if (m === "PUT") return update(req, env, await authenticate(env, req), id);
		if (m === "DELETE") {
			await deleteCustomer(env.DB, id, await authenticate(env, req));
			return noContent();
		}
	} else if (path.startsWith("/v1/customers/") && path.split("/").length === 5) {
		const [, , , rawId, sub] = path.split("/");
		const id = decodeURIComponent(rawId);
		if (sub === "transactions") {
			if (m === "GET") {
				await authenticate(env, req);
				const list = await listTransactions(env.DB, id);
				if (!list) throw notFound();
				return json(200, list);
			}
			if (m === "POST") return post(req, env, await authenticate(env, req), id);
		} else if (sub === "history") {
			if (m === "GET") {
				await authenticate(env, req);
				return json(200, await customerHistory(env.DB, id));
			}
		} else {
			throw new HttpError(404, "not_found", "no such endpoint");
		}
	} else {
		throw new HttpError(404, "not_found", "no such endpoint");
	}
	throw new HttpError(405, "method_not_allowed", `${m} is not allowed on ${path}`);
}

async function create(req: Request, env: Env, user: string): Promise<Response> {
	const { fields } = parseEditable(await readJSON(req, customerFields));
	return json(201, await createCustomer(env.DB, fields, user));
}

async function update(req: Request, env: Env, user: string, id: string): Promise<Response> {
	const { fields, version } = parseEditable(await readJSON(req, customerFields));
	return json(200, await updateCustomer(env.DB, id, fields, version, user));
}

async function post(req: Request, env: Env, user: string, id: string): Promise<Response> {
	return json(201, await postTransaction(env.DB, user, id, parsePosting(await readJSON(req, transactionFields))));
}
