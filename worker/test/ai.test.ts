import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseFilter, plain, syncIndex } from "../src/ai";
import { topics } from "../src/knowledge";
import { wrap } from "../src/screens/ask";
import { spoolStmts } from "../src/spool";
import { accessJWT } from "./access";
import { fakeAI, fakeIndex } from "./ai";

const worker = (exports as unknown as { default: Fetcher }).default;

interface Field { row: number; col: number; text?: string; name?: string; length?: number; value?: string; modified?: boolean }
interface Screen { map: string; rows: number; cols: number; fields: Field[]; cursor?: { field?: string } }

// A pared-down copy of the terminal in screens.test.ts.
class Terminal {
	state = "";
	scr!: Screen;
	vals: Record<string, string> = {};
	modified = new Set<string>();

	constructor(readonly token: string) {}

	static async logon() {
		const t = new Terminal(await accessJWT());
		await t.send("START");
		return t;
	}

	async send(aid: string) {
		const res = await worker.fetch("https://api.test/v1/screen", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": this.token },
			body: JSON.stringify({
				v: 1, aid, state: aid === "START" ? undefined : this.state, fields: this.vals,
				modified: [...this.modified], cursor: { row: 1, col: 1, field: "" }, rows: 24, cols: 80,
			}),
		});
		const body = await res.json<any>();
		expect(res.status, JSON.stringify(body)).toBe(200);
		this.state = body.state;
		this.scr = body.screen;
		this.vals = {};
		this.modified.clear();
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

	get text() {
		return Array.from({ length: this.scr.rows }, (_, i) => this.row(i + 1)).join("\n");
	}

	get message() {
		return this.row(this.scr.rows - 1).trim();
	}
}

const chatCalls = () => fakeAI.calls.filter((c) => c.input.messages);

beforeEach(() => fakeAI.reset());

describe("help index", () => {
	it("indexes the knowledge base and the products once, and again when they change", async () => {
		expect(await syncIndex(env)).toBe(true);
		const kb = topics();
		expect(fakeIndex.vectors.get("menu:1.2")?.namespace).toBe("help");
		expect(fakeIndex.vectors.get("product:BRG-6204")?.namespace).toBe("product");
		expect([...fakeIndex.vectors.values()].filter((v) => v.namespace === "help")).toHaveLength(kb.length);
		expect(await syncIndex(env)).toBe(false);

		await env.DB.prepare("UPDATE products SET updated = '2026-10-26T00:00:00Z' WHERE sku = 'BRG-6204'").run();
		fakeAI.calls = [];
		expect(await syncIndex(env)).toBe(true);
		// Only the products were embedded again.
		expect(fakeAI.calls.every((c) => c.input.text.every((t: string) => /^[A-Z]{3}-/.test(t)))).toBe(true);
	});

	it("builds topics from the menus, field help and job library", () => {
		const kb = topics();
		const ids = new Set(kb.map((t) => t.id));
		expect(ids.size).toBe(kb.length);
		for (const id of ["menu:1.2", "menu:5.4", "field:browse.status", "field:status", "job:CUSCRREV", "keys"]) {
			expect(ids.has(id), id).toBe(true);
		}
		expect(kb.find((t) => t.id === "field:browse.status")?.go).toBe("=1.1");
	});
});

describe("HELP", () => {
	it("answers a question from the command line and goes to a topic", async () => {
		await syncIndex(env);
		fakeAI.reply = (_system, user) => {
			expect(user).toContain("QUESTION: HOW DO I PUT A CUSTOMER ON HOLD");
			expect(user).toContain("CREDIT LIMITS AND HOLDS");
			return "**Change the status** to H on the customer panel:\n* =1.2, then PF5";
		};
		const t = await Terminal.logon();
		await t.fill("option", "HELP HOW DO I PUT A CUSTOMER ON HOLD").send("ENTER");
		expect(t.scr.map).toBe("CUSH02");
		expect(t.message).toMatch(/^CUS1201I/);
		expect(t.row(6).trim()).toBe("Change the status to H on the customer panel:");
		expect(t.row(7).trim()).toBe("- =1.2, then PF5");
		expect(t.text).toContain("RELATED TOPICS");

		// S beside a topic goes to its screen; PF3 there returns to its menu.
		const sel = t.scr.fields.filter((f) => f.name?.startsWith("sel:"));
		expect(sel.length).toBeGreaterThan(0);
		const i = sel.findIndex((f) => t.row(f.row).includes("CREDIT LIMITS AND HOLDS"));
		expect(i).toBeGreaterThanOrEqual(0);
		await t.fill(sel[i].name!, "S").send("ENTER");
		expect(t.scr.map).toBe("CUSM02"); // customer inquiry, =1.2
	});

	it("asks again on the panel, and shows the nearest topics when Workers AI is down", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "T").send("ENTER");
		expect(t.scr.map).toBe("CUSH00");
		await t.send("PF5");
		expect(t.scr.map).toBe("CUSH02");
		expect(t.scr.cursor).toEqual({ field: "q" });

		fakeAI.down = true;
		await t.fill("q", "what does the credit review job do").send("ENTER");
		expect(t.message).toMatch(/^CUS1202W HELP FACILITY NOT AVAILABLE/);
		expect(t.text).toContain("JOB CUSCRREV");

		fakeAI.down = false;
		await t.send("ENTER"); // the same question, unanswered: asks again
		expect(t.message).toMatch(/^CUS1201I/);
		expect(t.row(6).trim()).toBe("THE ANSWER");
		const asked = chatCalls().length;
		await t.send("ENTER"); // answered already: no new call
		expect(chatCalls()).toHaveLength(asked);
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM00");
	});

	it("is on the REST API", async () => {
		const headers = { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": await accessJWT() };
		let res = await worker.fetch("https://api.test/v1/ask", { method: "POST", headers, body: JSON.stringify({ question: "how do I ship by UPS" }) });
		expect(res.status).toBe(200);
		const body = await res.json<{ answer: string; topics: { id: string; go?: string }[] }>();
		expect(body.answer).toBe("THE ANSWER");
		expect(body.topics.length).toBeGreaterThan(0);

		fakeAI.down = true;
		res = await worker.fetch("https://api.test/v1/ask", { method: "POST", headers, body: JSON.stringify({ question: "x y" }) });
		expect(res.status).toBe(503);
		expect((await res.json<any>()).error.code).toBe("unavailable");
	});
});

describe("abend analysis", () => {
	async function addJob(id: string, rc: string, lines: string[]) {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO jobs (id, name, status, rc, submitted, submitted_by, started, ended)
				 VALUES (?, 'CUSCRREV', 'OUTPUT', ?, '2026-10-26T00:00:00Z', 'IBMUSER', '2026-10-26T00:00:01Z', '2026-10-26T00:00:02Z')`,
			).bind(id, rc),
			...spoolStmts(env.DB, { id, name: "CUSCRREV", owner: "IBMUSER", title: "CREDIT REVIEW" }, lines),
		]);
	}

	it("explains a failed job from the job list and from its output", async () => {
		await addJob("JOB90001", "ABEND", ["$HASP373 CUSCRREV STARTED", "IEF450I CUSCRREV STEP020 - ABEND=U0100", "  D1_ERROR: NO SUCH COLUMN"]);
		await addJob("JOB90002", "0000", ["$HASP395 CUSCRREV ENDED - RC=0000"]);
		fakeAI.reply = (system, user) => {
			expect(system).toContain("batch job");
			expect(user).toContain("RETURN CODE: ABEND");
			expect(user).toContain("IEF450I CUSCRREV STEP020 - ABEND=U0100");
			return "STEP020 failed on a database error. Rerun CUSCRREV.";
		};
		const t = await Terminal.logon();
		await t.fill("option", "5.1").send("ENTER");
		expect(t.text).toContain("E=EXPLAIN");
		const rowOf = (id: string) => t.scr.fields.find((f) => f.name?.startsWith("sel") && t.row(f.row).includes(id))!.name!;
		await t.fill(rowOf("JOB90001"), "E").send("ENTER");
		expect(t.scr.map).toBe("CUSJ03");
		expect(t.row(4)).toContain("CUSCRREV JOB90001 RC=ABEND");
		expect(t.row(6).trim()).toBe("STEP020 failed on a database error. Rerun CUSCRREV.");
		expect(t.message).toMatch(/^CUS1206I/);
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSJ01");

		await t.fill(rowOf("JOB90002"), "E").send("ENTER");
		expect(t.scr.map).toBe("CUSJ01");
		expect(t.message).toBe("CUS1205I CUSCRREV JOB90002 ENDED RC=0000 - NOTHING TO EXPLAIN");

		await t.fill(rowOf("JOB90001"), "S").send("ENTER");
		expect(t.scr.map).toBe("CUSJ02");
		expect(t.row(24)).toContain("PF6=EXPLAIN");
		fakeAI.down = true;
		await t.send("PF6");
		expect(t.scr.map).toBe("CUSJ03");
		expect(t.message).toMatch(/^CUS1204E ABEND ANALYSIS NOT AVAILABLE/);
	});

	it("is on the REST API", async () => {
		await addJob("JOB90003", "0004", ["IEF142I CUSCRREV STEP020 - STEP WAS EXECUTED - COND CODE 0004"]);
		const headers = { "Cf-Access-Jwt-Assertion": await accessJWT() };
		const res = await worker.fetch("https://api.test/v1/jobs/JOB90003/explain", { method: "POST", headers });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ explanation: "THE ANSWER" });
		const missing = await worker.fetch("https://api.test/v1/jobs/JOB99999/explain", { method: "POST", headers });
		expect(missing.status).toBe(404);
	});
});

describe("plain-English search", () => {
	it("turns a sentence into a filter when no name matches, and pages without asking again", async () => {
		await env.DB.prepare("UPDATE customers SET balance = 60000 WHERE id = '000101'").run();
		fakeAI.reply = (system, user, schema) => {
			expect(schema).toBe(true);
			expect(system).toContain("JSON filter");
			expect(user).toBe("customers in ohio over their credit limit");
			return { type: "C", state: "OH", over_limit: true, text: "" };
		};
		const t = await Terminal.logon();
		await t.fill("option", "FIND customers in ohio over their credit limit").send("ENTER");
		expect(t.scr.map).toBe("CUSF01");
		expect(t.message).toBe("CUS1003I SEARCHED FOR CUSTOMERS IN OH OVER CREDIT LIMIT");
		expect(t.row(9)).toMatch(/CUSTOMER\s+000101\s+ACME TOOL & DIE/);
		expect(t.row(10).trim()).toBe("");
		const asked = chatCalls().length;
		await t.send("PF8");
		await t.send("PF7");
		expect(t.row(9)).toContain("000101");
		expect(chatCalls()).toHaveLength(asked);

		// A name that matches is an ordinary search, and never asks.
		await t.fill("q", "great lakes").send("ENTER");
		expect(t.row(9)).toMatch(/VENDOR\s+V00002/);
		expect(chatCalls()).toHaveLength(asked);
	});

	it("starts with ? to always ask, finds products by meaning, and copes with Workers AI down", async () => {
		await syncIndex(env);
		fakeAI.reply = () => ({ type: "P", text: "brass fitting" });
		const query = vi.spyOn(fakeIndex, "query").mockResolvedValueOnce({
			count: 1, matches: [{ id: "product:VLV-0100", score: 0.82 }],
		});
		const t = await Terminal.logon();
		await t.fill("option", "1.5").send("ENTER");
		await t.fill("q", "?brass fittings").send("ENTER");
		expect(query).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ namespace: "product" }));
		query.mockRestore();
		expect(t.message).toBe("CUS1003I SEARCHED FOR PRODUCTS MATCHING BRASS FITTING");
		expect(t.row(9)).toMatch(/PRODUCT\s+VLV-0100\s+BALL VALVE/);

		fakeAI.down = true;
		await t.fill("q", "?open invoices").send("ENTER");
		expect(t.message).toMatch(/^CUS1004W/);
		await t.fill("q", "nothing called this").send("ENTER");
		expect(t.message).toBe("");
		expect(t.text).toContain("NOTHING MATCHES");
	});

	it("is on the REST API", async () => {
		fakeAI.reply = () => ({ type: "I", status: "O", min_amount: 0, bogus: 1 });
		const headers = { "Cf-Access-Jwt-Assertion": await accessJWT() };
		const res = await worker.fetch("https://api.test/v1/search/natural?q=open%20invoices", { headers });
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		expect(body.filter).toEqual({ type: "I", status: "O", min: 0 });
		expect(body.description).toBe("INVOICES STATUS O FROM $0");
		expect(Array.isArray(body.hits)).toBe(true);
	});
});

describe("helpers", () => {
	it("keeps only the parts of a filter that fit the record type", () => {
		expect(parseFilter({ type: "p", text: "pump", state: "OH", over_limit: true, low_stock: true, status: "Z" }))
			.toEqual({ type: "P", text: "PUMP", lowStock: true });
		expect(parseFilter({ type: "C", state: "Ohio", status: "h", min_amount: 100.4 })).toEqual({ type: "C", status: "H", min: 100 });
		expect(() => parseFilter({ type: "Q" })).toThrow();
		expect(() => parseFilter("customers")).toThrow();
	});

	it("strips markdown and wraps answers to the screen", () => {
		expect(plain("## Steps\n**Bold** and `code`\n* one\n— dash “q”")).toBe('Steps\nBold and code\n- one\n- dash "q"');
		expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
		expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"]);
		expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
	});
});
