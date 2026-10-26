import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { record, stats } from "../src/monitor";
import { monitor } from "../src/screens/monitor";
import type { Ctx } from "../src/screens/screen";
import { carrierRates, chooseCarrier, freight, taxRate } from "../src/systables";
import { accessJWT, fetchSpy } from "./access";

const worker = (exports as unknown as { default: Fetcher }).default;

async function call(method: string, path: string, body?: unknown) {
	const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await accessJWT() };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await worker.fetch(`https://api.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	return { status: res.status, body: res.status === 204 ? null : await res.json<any>() };
}

interface Field { row: number; col: number; text?: string; name?: string; length?: number; value?: string; modified?: boolean }

// A small stand-in for the terminal, as in screens.test.ts.
class Terminal {
	state = "";
	scr!: { map: string; rows: number; cols: number; fields: Field[]; refresh?: number };
	vals: Record<string, string> = {};
	modified = new Set<string>();
	cursorField = "";

	static async logon() {
		return new Terminal().send("START");
	}

	async send(aid: string) {
		const res = await worker.fetch("https://api.test/v1/screen", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": await accessJWT() },
			body: JSON.stringify({
				v: 1, aid, state: aid === "START" ? undefined : this.state, fields: this.vals, modified: [...this.modified],
				cursor: { row: 1, col: 1, field: this.cursorField }, rows: 24, cols: 80, terminal: "TERM0001", system: "TEST",
			}),
		});
		const body = await res.json<any>();
		expect(res.status, JSON.stringify(body)).toBe(200);
		this.state = body.state;
		this.scr = body.screen;
		this.vals = {};
		this.modified.clear();
		this.cursorField = "";
		for (const f of this.scr.fields) if (f.name) this.vals[f.name] = f.value ?? "";
		return this;
	}

	fill(...kv: string[]) {
		for (let i = 0; i < kv.length; i += 2) {
			expect(this.scr.fields.some((f) => f.name === kv[i]), `field ${kv[i]}`).toBe(true);
			this.vals[kv[i]] = kv[i + 1];
			this.modified.add(kv[i]);
		}
		return this;
	}

	row(n: number): string {
		const line = Array(this.scr.cols).fill(" ");
		for (const f of this.scr.fields) {
			if (f.row !== n) continue;
			const s = f.text ?? (f.value ?? "").padEnd(f.length ?? 0);
			for (let i = 0; i < s.length && f.col - 1 + i < line.length; i++) line[f.col - 1 + i] = s[i];
		}
		return line.join("");
	}

	text(): string {
		return Array.from({ length: this.scr.rows }, (_, i) => this.row(i + 1)).join("\n");
	}

	get message() {
		return this.row(this.scr.rows - 1).trim();
	}
}

beforeEach(async () => {
	for (const t of ["CARRIER", "TAXCODE", "HELP"]) await env.TABLES.delete(`table:${t}`);
});

describe("system tables", () => {
	it("lists the tables with their defaults", async () => {
		const res = await call("GET", "/v1/tables");
		expect(res.status).toBe(200);
		expect(res.body.map((t: any) => [t.name, t.custom])).toEqual([["CARRIER", false], ["TAXCODE", false], ["HELP", false]]);
		const carrier = await call("GET", "/v1/tables/carrier");
		expect(carrier.body.rows.map((r: any) => r.key)).toEqual(["FDX", "TRK", "UPS"]);
		expect((await call("GET", "/v1/tables/NOPE")).status).toBe(404);
	});

	it("adds, changes, deletes and resets rows", async () => {
		const put = await call("PUT", "/v1/tables/TAXCODE/ca", { desc: "California", rate: "7.25", freight: "n" });
		expect(put.status).toBe(200);
		expect(put.body).toEqual({ key: "CA", desc: "CALIFORNIA", rate: 7.25, freight: "N" });
		expect(await taxRate(env.TABLES, "ca")).toEqual({ rate: 7.25, freight: false });
		expect(await taxRate(env.TABLES, "OH")).toEqual({ rate: 5.75, freight: true });

		const bad = await call("PUT", "/v1/tables/TAXCODE/CA", { desc: "CALIFORNIA", rate: 30, freight: "N" });
		expect(bad.status).toBe(422);
		expect(bad.body.error.field).toBe("rate");
		expect((await call("PUT", "/v1/tables/TAXCODE/CAL", { desc: "X", rate: 1, freight: "N" })).body.error.field).toBe("key");
		expect((await call("PUT", "/v1/tables/TAXCODE/CA", { desc: "X", rate: 1, freight: "N", extra: 1 })).status).toBe(400);

		expect((await call("DELETE", "/v1/tables/TAXCODE/OH")).status).toBe(204);
		expect((await call("DELETE", "/v1/tables/TAXCODE/OH")).status).toBe(404);
		expect(await taxRate(env.TABLES, "OH")).toEqual({ rate: 0, freight: false });
		const list = await call("GET", "/v1/tables");
		expect(list.body.find((t: any) => t.name === "TAXCODE").custom).toBe(true);

		expect((await call("DELETE", "/v1/tables/TAXCODE")).status).toBe(204);
		expect(await taxRate(env.TABLES, "OH")).toEqual({ rate: 5.75, freight: true });
		expect(await taxRate(env.TABLES, "CA")).toEqual({ rate: 0, freight: false });

		const log = await env.DB.prepare("SELECT text FROM syslog WHERE text LIKE 'CUS080%' ORDER BY seq").all<{ text: string }>();
		expect(log.results.map((r) => r.text)).toEqual(expect.arrayContaining([
			"CUS0801I IBMUSER ADDED TAXCODE CA", "CUS0802I IBMUSER DELETED TAXCODE OH", "CUS0803I IBMUSER RESET TAXCODE TO ITS DEFAULTS",
		]));
	});

	it("routes orders like the shipping desk by default", async () => {
		const carriers = await carrierRates(env.TABLES);
		expect(carriers.map((c) => c.code)).toEqual(["UPS", "TRK", "FDX"]);
		const pick = (state: string, weight: number, maxCarton: number, value: number) =>
			chooseCarrier(carriers, { state, weight, maxCarton, value })?.code;
		expect(pick("OH", 40, 20, 300)).toBe("UPS");
		expect(pick("OH", 900, 200, 20000)).toBe("TRK");
		expect(pick("PA", 100, 71, 300)).toBe("TRK");
		expect(pick("NY", 40, 20, 300)).toBe("UPS");
		expect(pick("NY", 149, 70, 4999)).toBe("UPS");
		expect(pick("NY", 10, 5, 5000)).toBe("FDX");
		expect(pick("KY", 10, 5, 5000)).toBe("TRK");
		expect(pick("NY", 150, 20, 300)).toBe("FDX");
		expect(pick("NY", 100, 71, 300)).toBe("FDX");
		expect(freight(carriers[0], 10)).toBe(21);
	});
});

describe("system table screens", () => {
	it("changes a carrier from the OPERATIONS menu", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "5.6").send("ENTER");
		expect(t.scr.map).toBe("CUSO04");
		expect(t.row(8)).toContain("CARRIER");
		expect(t.row(8)).toContain("DEFAULT");
		await t.fill("sel0", "S").send("ENTER");
		expect(t.scr.map).toBe("CUSO05");
		expect(t.text()).toContain("UPS GROUND");
		const ups = t.scr.fields.find((f) => f.text?.startsWith("UPS"))!;
		await t.fill(`sel${ups.row - 9}`, "U").send("ENTER");
		expect(t.scr.map).toBe("CUSO06");
		expect(t.vals.name).toBe("UPS GROUND");
		await t.fill("max_weight_lb", "abc").send("ENTER");
		expect(t.message).toMatch(/^CUS0806E MAX WEIGHT LB MUST BE A WHOLE NUMBER/);
		await t.fill("max_weight_lb", "120").send("ENTER");
		expect(t.scr.map).toBe("CUSO05");
		expect(t.message).toBe("CUS0801I CARRIER UPS CHANGED");
		expect((await carrierRates(env.TABLES)).find((c) => c.code === "UPS")!.max_weight_lb).toBe(120);

		await t.send("PF9");
		expect(t.message).toMatch(/^CUS0805W PRESS PF9 AGAIN/);
		await t.send("PF9");
		expect(t.message).toBe("CUS0803I CARRIER RESET TO ITS DEFAULTS");
		expect((await carrierRates(env.TABLES)).find((c) => c.code === "UPS")!.max_weight_lb).toBe(149);
	});

	it("adds help text that PF1 shows", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "TABLES").send("ENTER");
		await t.fill("sel2", "S").send("ENTER");
		expect(t.text()).toContain("THE TABLE IS EMPTY");
		await t.send("PF5");
		expect(t.scr.map).toBe("CUSO06");
		await t.fill("key", "menu.option", "title", "Pick an option", "text:0", "Type a number, then Enter.").send("ENTER");
		expect(t.message).toBe("CUS0801I HELP MENU.OPTION ADDED");
		await t.send("PF3");
		await t.send("PF3");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM00");
		t.cursorField = "option";
		await t.send("PF1");
		expect(t.scr.map).toBe("CUSH01");
		expect(t.row(1)).toContain("HELP - PICK AN OPTION");
		expect(t.row(4)).toContain("Type a number, then Enter.");
		// The built-in list of valid values is kept.
		expect(t.text()).toContain("VALID VALUES");
	});
});

describe("transaction monitor", () => {
	it("writes a data point per request", () => {
		const points: AnalyticsEngineDataPoint[] = [];
		record({ ...env, TXN: { writeDataPoint: (p) => p && points.push(p) } }, {
			tran: "CUSM00", kind: "SCREEN", user: "IBMUSER", terminal: "TERM0001", ms: 12, status: 200,
		});
		record({ ...env, TXN: { writeDataPoint: () => { throw new Error("full"); } } }, {
			tran: "GET /v1/health", kind: "API", user: "", terminal: "", ms: 1, status: 500,
		});
		expect(points).toEqual([{ indexes: ["CUSM00"], blobs: ["CUSM00", "SCREEN", "IBMUSER", "TERM0001"], doubles: [12, 200, 0] }]);
	});

	it("times screens by map and API calls by route", async () => {
		const spy = vi.spyOn(env.TXN!, "writeDataPoint");
		await call("GET", "/v1/customers/000001");
		await call("GET", "/v1/nowhere");
		await Terminal.logon();
		const points = spy.mock.calls.map(([p]) => p!.blobs!.slice(0, 3));
		spy.mockRestore();
		expect(points).toEqual([["GET /v1/customers/:id", "API", "IBMUSER"], ["UNKNOWN", "API", ""], ["CUSM00", "SCREEN", "IBMUSER"]]);
	});

	it("says when it is not set up", async () => {
		expect((await call("GET", "/v1/monitor")).status).toBe(503);
		expect((await call("GET", "/v1/monitor?minutes=7")).status).toBe(400);
		const t = await Terminal.logon();
		await t.fill("option", "MONITOR").send("ENTER");
		expect(t.scr.map).toBe("CUSO03");
		expect(t.message).toBe("CUS0811W TRANSACTION STATISTICS NOT SET UP - AE_API_TOKEN SECRET MISSING");
	});

	describe("with Analytics Engine", () => {
		const queries: string[] = [];
		const prev = fetchSpy.getMockImplementation()!;
		beforeEach(() => {
			queries.length = 0;
			fetchSpy.mockImplementation(async (input, init) => {
				const url = input instanceof Request ? input.url : String(input);
				if (!url.endsWith("/analytics_engine/sql")) return prev(input, init);
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer ae-token");
				const sql = String(init?.body);
				queries.push(sql);
				if (sql.includes("GROUP BY tran")) {
					return Response.json({ data: [
						{ tran: "CUSM00", kind: "SCREEN", count: "120", avg_ms: 30, max_ms: 210, p95_ms: 90, abends: "0" },
						{ tran: "GET /v1/customers/:id", kind: "API", count: "30", avg_ms: 80, max_ms: 400, p95_ms: 300, abends: "2" },
					] });
				}
				return Response.json({ data: [
					{ at: "2026-10-26 00:14:00", count: "100", avg_ms: 35, abends: "2" },
					{ at: "2026-10-26 00:13:00", count: "50", avg_ms: 50, abends: "0" },
				] });
			});
		});
		afterEach(() => {
			fetchSpy.mockImplementation(prev);
		});
		const aeEnv = { ...env, AE_API_TOKEN: "ae-token", CF_ACCOUNT_ID: "acct" };

		it("summarises by transaction and over time", async () => {
			const st = await stats(aeEnv, 15, 14);
			expect(queries[0]).toContain("FROM customer_transactions WHERE timestamp > NOW() - INTERVAL '15' MINUTE");
			expect(queries[0]).toMatch(/FORMAT JSON$/);
			expect(st.bucket).toBe(2);
			expect(st.total).toEqual({ count: 150, tpm: 10, avg_ms: 40, max_ms: 400, abends: 2 });
			expect(st.trans[1]).toEqual({ tran: "GET /v1/customers/:id", kind: "API", count: 30, avg_ms: 80, max_ms: 400, p95_ms: 300, abends: 2 });
			expect(st.intervals[0]).toEqual({ at: "2026-10-26T00:14:00.000Z", count: 100, avg_ms: 35, abends: 2 });
		});

		it("draws the monitor screen", async () => {
			const ctx = { env: aeEnv, db: env.DB, tables: env.TABLES, jobs: env.JOBS, user: "IBMUSER", rows: 24, cols: 80,
				system: "TEST", terminal: "TERM0001", host: "api.test", tzOffset: 0 } satisfies Ctx;
			const s = { p: "monitor" as const, back: { p: "menu" as const } };
			let scr = await monitor.render(ctx, s);
			const text = (sc: typeof scr) => sc.fields.map((f) => f.text ?? "").join("\n");
			expect(scr.refresh).toBe(30);
			expect(text(scr)).toContain("INTERVAL: LAST 15 MINUTES   VIEW: BY TRANSACTION");
			expect(text(scr)).toMatch(/CUSM00 +SCREEN +120 +8\.0 +30 +90 +210 +0/);
			expect(await monitor.handle(ctx, s, { aid: "PF6", fields: {}, modified: new Set(), cursorField: "" })).toBe(s);
			scr = await monitor.render(ctx, s);
			expect(text(scr)).toContain("VIEW: BY TIME");
			expect(text(scr)).toContain("#".repeat(33));
			await monitor.handle(ctx, s, { aid: "PF11", fields: {}, modified: new Set(), cursorField: "" });
			expect(s).toMatchObject({ minutes: 60 });
			await monitor.handle(ctx, s, { aid: "PF10", fields: {}, modified: new Set(), cursorField: "" });
			await monitor.handle(ctx, s, { aid: "PF10", fields: {}, modified: new Set(), cursorField: "" });
			await monitor.handle(ctx, s, { aid: "PF10", fields: {}, modified: new Set(), cursorField: "" });
			expect(s).toMatchObject({ minutes: 5, msg: "CUS0812W 5 MINUTES IS THE SHORTEST INTERVAL" });
		});
	});
});
