import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const worker = (exports as unknown as { default: Fetcher }).default;

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
	const headers: Record<string, string> = {};
	if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
	if (opts.body !== undefined) headers["Content-Type"] = "application/json";
	const res = await worker.fetch(`https://api.test${path}`, {
		method,
		headers,
		body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function logon(userid = "ibmuser", password = "sys1") {
	const res = await call("POST", "/v1/session", { body: { userid, password } });
	expect(res.status).toBe(201);
	return res.body.token as string;
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

	it("rejects bad passwords and unknown users alike", async () => {
		for (const body of [{ userid: "ibmuser", password: "nope" }, { userid: "nobody", password: "sys1" }]) {
			const res = await call("POST", "/v1/session", { body });
			expect(res.status).toBe(401);
			expect(res.body.error.code).toBe("bad_logon");
		}
	});

	it("issues tokens and ends them on logoff", async () => {
		const res = await call("POST", "/v1/session", { body: { userid: " ibmuser ", password: "SyS1" } });
		expect(res.status).toBe(201);
		expect(res.body.userid).toBe("IBMUSER");
		expect(Date.parse(res.body.expires_at)).toBeGreaterThan(Date.now());

		const token = res.body.token;
		expect((await call("GET", "/v1/customers", { token })).status).toBe(200);
		expect((await call("DELETE", "/v1/session", { token })).status).toBe(204);
		expect((await call("GET", "/v1/customers", { token })).status).toBe(401);
	});

	it("rejects unknown fields", async () => {
		const res = await call("POST", "/v1/session", { body: { userid: "a", pw: "b" } });
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

describe("routing", () => {
	it("returns JSON errors for unknown paths and methods", async () => {
		expect((await call("GET", "/nope")).body.error.code).toBe("not_found");
		const res = await call("PATCH", "/v1/customers");
		expect(res.status).toBe(405);
	});
});
