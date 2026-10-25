import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accessJWT } from "./access";

const worker = (exports as unknown as { default: Fetcher }).default;

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
	const headers: Record<string, string> = {};
	if (opts.token) headers["Cf-Access-Jwt-Assertion"] = opts.token;
	if (opts.body !== undefined) headers["Content-Type"] = "application/json";
	const res = await worker.fetch(`https://api.test${path}`, {
		method,
		headers,
		body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

// logon returns an Access JWT for IBMUSER, after checking the API accepts it.
async function logon() {
	const token = await accessJWT();
	const res = await call("POST", "/v1/session", { token });
	expect(res).toEqual({ status: 201, body: { userid: "IBMUSER" } });
	return token;
}

// What the Go client sends: the whole record, server-owned fields included.
const newCustomer = {
	id: "", name: "new co", address: "1 main st", city: "reno", state: "nv", zip: "89501",
	phone: "", credit_limit: 1000, balance: 999, status: "a", version: 0,
	updated: "0001-01-01T00:00:00Z", updated_by: "",
};

describe("sessions", () => {
	it("serves health without a logon", async () => {
		expect(await call("GET", "/v1/health")).toEqual({ status: 200, body: { status: "ok" } });
	});

	it("requires a logon", async () => {
		const res = await call("GET", "/v1/customers");
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe("unauthorized");
	});

	it("rejects requests without a valid Access JWT", async () => {
		const now = Math.floor(Date.now() / 1000);
		const bad = [
			"",
			"not.a.jwt",
			await accessJWT({ aud: ["some-other-app"] }),
			await accessJWT({ iss: "https://evil.cloudflareaccess.com" }),
			await accessJWT({ exp: now - 3600 }),
			await accessJWT({ nbf: now + 3600 }),
			await accessJWT({}, "unknown-kid"),
			(await accessJWT()).slice(0, -4) + "AAAA", // bad signature
		];
		for (const token of bad) {
			const res = await call("POST", "/v1/session", { token });
			expect(res.status, token).toBe(401);
			expect(res.body.error.code).toBe("unauthorized");
		}
	});

	it("derives the userid from the Access identity", async () => {
		for (const [claims, userid] of [
			[{ email: "j.doe-smith@example.com" }, "JDOESMIT"],
			[{ email: undefined, common_name: "abc123.access" }, "SERVICE"],
		] as const) {
			const res = await call("POST", "/v1/session", { token: await accessJWT(claims) });
			expect(res.body.userid).toBe(userid);
		}
	});

	it("records the Access user on changes", async () => {
		const token = await accessJWT({ email: "jdoe@example.com" });
		const { body: current } = await call("GET", "/v1/customers/000110", { token });
		const res = await call("PUT", "/v1/customers/000110", { token, body: current });
		expect(res.body.updated_by).toBe("JDOE");
	});

	it("rejects unknown fields", async () => {
		const res = await call("POST", "/v1/customers", { token: await logon(), body: { ...newCustomer, pw: "b" } });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("bad_request");
	});
});

describe("customers", () => {
	it("lists by name prefix, in name order", async () => {
		const token = await logon();
		const all = await call("GET", "/v1/customers", { token });
		expect(all.body).toHaveLength(24);
		expect(all.body[0].name).toBe("ACME TOOL & DIE");

		const k = await call("GET", "/v1/customers?prefix=k", { token });
		expect(k.body.map((c: { name: string }) => c.name)).toEqual(["KEYSTONE STEEL"]);

		const ca = await call("GET", "/v1/customers?city=fre&state=ca&status=h", { token });
		expect(ca.body.map((c: { id: string }) => c.id)).toEqual(["000118"]);
		expect((await call("GET", "/v1/customers?state=oh&status=c", { token })).body).toEqual([]);

		// LIKE wildcards in the prefix are literal.
		expect((await call("GET", "/v1/customers?prefix=%25", { token })).body).toEqual([]);
	});

	it("gets one customer, or 404", async () => {
		const token = await logon();
		const res = await call("GET", "/v1/customers/000105", { token });
		expect(res.body).toMatchObject({ id: "000105", name: "EVERGREEN TIMBER CO", credit_limit: 40000, version: 1 });
		const missing = await call("GET", "/v1/customers/999999", { token });
		expect(missing.status).toBe(404);
		expect(missing.body.error.code).toBe("not_found");
	});

	it("validates writes and names the field", async () => {
		const token = await logon();
		const res = await call("POST", "/v1/customers", { token, body: { ...newCustomer, zip: "1" } });
		expect(res.status).toBe(422);
		expect(res.body.error).toEqual({ code: "invalid", field: "zip", message: "zip code must be five digits" });

		const typed = await call("POST", "/v1/customers", { token, body: { ...newCustomer, credit_limit: "lots" } });
		expect(typed.status).toBe(400);
	});

	it("creates with the next number, normalized, with a zero balance", async () => {
		const token = await logon();
		const res = await call("POST", "/v1/customers", { token, body: newCustomer });
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({
			id: "000125", name: "NEW CO", city: "RENO", status: "A", balance: 0, version: 1, updated_by: "IBMUSER",
		});
		const again = await call("POST", "/v1/customers", { token, body: newCustomer });
		expect(again.body.id).toBe("000126");
	});

	it("updates with optimistic locking", async () => {
		const token = await logon();
		const { body: current } = await call("GET", "/v1/customers/000101", { token });

		const ok = await call("PUT", "/v1/customers/000101", { token, body: { ...current, city: "kettering", balance: 1 } });
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ city: "KETTERING", version: 2, balance: current.balance });

		const stale = await call("PUT", "/v1/customers/000101", { token, body: { ...current, city: "xenia" } });
		expect(stale.status).toBe(409);
		expect(stale.body.error.code).toBe("conflict");

		const gone = await call("PUT", "/v1/customers/999999", { token, body: { ...current, id: "999999" } });
		expect(gone.status).toBe(404);
	});

	it("deletes", async () => {
		const token = await logon();
		expect((await call("DELETE", "/v1/customers/000112", { token })).status).toBe(204);
		expect((await call("GET", "/v1/customers/000112", { token })).status).toBe(404);
		expect((await call("DELETE", "/v1/customers/000112", { token })).status).toBe(404);
	});
});

describe("activity", () => {
	it("posts invoices and payments and moves the balance", async () => {
		const token = await logon();
		const { body: before } = await call("GET", "/v1/customers/000102", { token });

		const inv = await call("POST", "/v1/customers/000102/transactions", {
			token, body: { type: "i", amount: 500, reference: "inv 1001" },
		});
		expect(inv.status).toBe(201);
		expect(inv.body).toMatchObject({
			customer_id: "000102", type: "I", amount: 500, reference: "INV 1001",
			balance: before.balance + 500, posted_by: "IBMUSER",
		});
		const pay = await call("POST", "/v1/customers/000102/transactions", {
			token, body: { type: "P", amount: 200 },
		});
		expect(pay.body.balance).toBe(before.balance + 300);

		const { body: after } = await call("GET", "/v1/customers/000102", { token });
		expect(after.balance).toBe(before.balance + 300);
		expect(after.version).toBe(before.version); // posting is not an edit

		const list = await call("GET", "/v1/customers/000102/transactions", { token });
		expect(list.body.map((t: { type: string }) => t.type)).toEqual(["P", "I"]);
	});

	it("validates postings and names the field", async () => {
		const token = await logon();
		const cases: [unknown, string][] = [
			[{ type: "X", amount: 1 }, "type"],
			[{ type: "I", amount: 0 }, "amount"],
			[{ type: "I", amount: 5, reference: "much too long ref" }, "ref"],
		];
		for (const [body, field] of cases) {
			const res = await call("POST", "/v1/customers/000104/transactions", { token, body });
			expect(res.status).toBe(422);
			expect(res.body.error.field).toBe(field);
		}
	});

	it("takes payments but not invoices on hold or closed accounts", async () => {
		const token = await logon();
		const hold = await call("POST", "/v1/customers/000103/transactions", { token, body: { type: "I", amount: 1 } });
		expect(hold.status).toBe(422);
		expect(hold.body.error.message).toContain("on hold");
		const pay = await call("POST", "/v1/customers/000103/transactions", { token, body: { type: "P", amount: 1 } });
		expect(pay.status).toBe(201);
		const missing = await call("POST", "/v1/customers/999999/transactions", { token, body: { type: "P", amount: 1 } });
		expect(missing.status).toBe(404);
	});
});

describe("history", () => {
	it("records adds, field changes and deletes", async () => {
		const token = await logon();
		const { body: created } = await call("POST", "/v1/customers", { token, body: newCustomer });
		const id = created.id;
		const jdoe = await accessJWT({ email: "jdoe@example.com" });
		await call("PUT", `/v1/customers/${id}`, { token: jdoe, body: { ...created, city: "sparks", credit_limit: 2000 } });

		// A stale update changes nothing and records nothing.
		const stale = await call("PUT", `/v1/customers/${id}`, { token, body: { ...created, city: "elko" } });
		expect(stale.status).toBe(409);

		expect((await call("DELETE", `/v1/customers/${id}`, { token })).status).toBe(204);
		const res = await call("GET", `/v1/customers/${id}/history`, { token });
		expect(res.body.map((c: Record<string, string>) => [c.action, c.field, c.old_value, c.new_value, c.by])).toEqual([
			["DELETE", "", "", "", "IBMUSER"],
			["CHANGE", "LIMIT", "1000", "2000", "JDOE"],
			["CHANGE", "CITY", "RENO", "SPARKS", "JDOE"],
			["ADD", "", "", "", "IBMUSER"],
		]);
	});
});

describe("routing", () => {
	it("returns JSON errors for unknown paths and methods", async () => {
		expect((await call("GET", "/nope")).body.error.code).toBe("not_found");
		const res = await call("PATCH", "/v1/customers");
		expect(res.status).toBe(405);
	});

	it("answers 404 and 405 before asking for a logon", async () => {
		expect(await call("GET", "/v1/customers/000001/nope")).toEqual({
			status: 404,
			body: { error: { code: "not_found", message: "no such endpoint" } },
		});
		expect(await call("POST", "/v1/jobs/JOB00001/")).toEqual({
			status: 405,
			body: { error: { code: "method_not_allowed", message: "POST is not allowed on /v1/jobs/JOB00001" } },
		});
		expect((await call("GET", "/v1/customers/000001")).status).toBe(401);
	});

	it("ignores a trailing slash", async () => {
		expect((await call("GET", "/v1/health/")).status).toBe(200);
		const token = await logon();
		expect((await call("GET", "/v1/customers/000101/", { token })).body.id).toBe("000101");
	});
});

describe("browser terminal", () => {
	// Static assets are served in front of the Worker, so ask them directly.
	it("serves the page and its scripts", async () => {
		for (const [path, type] of [
			["/", "text/html"],
			["/terminal.js", "javascript"],
			["/screen.js", "javascript"],
			["/protocol.js", "javascript"],
			["/terminal.css", "text/css"],
		]) {
			const res = await env.ASSETS.fetch(`https://api.test${path}`);
			expect(res.status, path).toBe(200);
			expect(res.headers.get("Content-Type"), path).toContain(type);
			await res.arrayBuffer();
		}
	});
});
