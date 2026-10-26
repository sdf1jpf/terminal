import { introspectWorkflowInstance } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { archiveSpool } from "../src/archive";
import { buildStatements, invoicePdf, letterPdf, listingPdf, statementPdf } from "../src/documents";
import { addLine, billInvoice, createInvoice, getInvoice } from "../src/invoices";
import { getCustomer } from "../src/data";
import { dunningLetters } from "../src/ledger";
import { Pdf } from "../src/pdf";
import { spoolReport } from "../src/spool";
import { accessJWT } from "./access";
import { shipInvoice } from "./ship";

const worker = (exports as unknown as { default: Fetcher }).default;

async function call(method: string, path: string, body?: unknown) {
	const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await accessJWT() };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await worker.fetch(`https://api.test${path}`, {
		method, headers, body: body === undefined ? undefined : JSON.stringify(body),
	});
	const type = res.headers.get("Content-Type") ?? "";
	const out = res.status === 204 ? null
		: type.startsWith("application/json") ? await res.json<any>()
		: type === "application/pdf" ? new Uint8Array(await res.arrayBuffer())
		: await res.text();
	return { status: res.status, type, disposition: res.headers.get("Content-Disposition") ?? "", body: out };
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

// checkPdf parses just enough of a PDF to know a reader can open it: the
// header, the trailer, and every cross-reference offset landing on its
// object. It returns the number of pages.
function checkPdf(b: Uint8Array): number {
	const s = text(b);
	expect(s.startsWith("%PDF-1.4\n")).toBe(true);
	expect(s.endsWith("%%EOF\n")).toBe(true);
	const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)![1]);
	expect(s.slice(start, start + 4)).toBe("xref");
	const [, count] = /^xref\n0 (\d+)\n/.exec(s.slice(start))!.map(Number);
	const offsets = s.slice(start).split("\n").slice(3, 2 + count).map((l) => Number(l.slice(0, 10)));
	offsets.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
	return Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)![1]);
}

async function billedInvoice(customer = "000101") {
	const inv = await createInvoice(env.DB, "IBMUSER", customer, "PO-PDF-1");
	await addLine(env.DB, inv.id, "BLT-0516", 3);
	await shipInvoice(env.DB, inv.id);
	await billInvoice(env.DB, "IBMUSER", inv.id);
	return inv.id;
}

describe("PDF writer", () => {
	it("writes a file a reader can open", () => {
		const pdf = new Pdf("TEST (1)");
		pdf.page().text(36, 36, "HELLO (WORLD) \\ é").rect(0, 0, 10, 10, [0, 1, 0]).circle(50, 50, 5, [0, 0, 0]);
		pdf.page(792, 612).line(0, 0, 10, 10).box(5, 5, 20, 20);
		const b = pdf.bytes();
		expect(checkPdf(b)).toBe(2);
		expect(text(b)).toContain("(HELLO \\(WORLD\\) \\\\ ?) Tj");
		expect(text(b)).toContain("/MediaBox [0 0 792 612]");
		expect(text(b)).toContain("/Title (TEST \\(1\\))");
	});

	it("prints listings on green-bar paper, a page per printer page", () => {
		const o = { id: "JOB00009", name: "CUSSTMT", title: "CUSTOMER STATEMENTS" };
		const b = listingPdf(o, Array.from({ length: 100 }, (_, i) => `LINE ${i + 1}`));
		expect(checkPdf(b)).toBe(2);
		expect(text(b)).toContain("/MediaBox [0 0 1071 792]");
		expect(text(b)).toContain("(LINE 58) Tj");
	});
});

describe("documents", () => {
	it("serves an invoice, a statement and a spool listing as PDFs", async () => {
		const id = await billedInvoice();
		let res = await call("GET", `/v1/invoices/${id.toLowerCase()}/pdf`);
		expect(res.status).toBe(200);
		expect(res.type).toBe("application/pdf");
		expect(res.disposition).toBe(`inline; filename="${id}.pdf"`);
		checkPdf(res.body);
		expect(text(res.body)).toContain(` ${id}) Tj`);
		expect(text(res.body)).toContain(" PO-PDF-1) Tj");
		expect((await call("GET", "/v1/invoices/INV99999/pdf")).status).toBe(404);

		res = await call("GET", "/v1/customers/000101/statement");
		expect(res.status).toBe(200);
		checkPdf(res.body);
		expect(text(res.body)).toContain("STATEMENT");
		expect(text(res.body)).toContain(`  INVOICE  ${id}`);
		expect((await call("GET", "/v1/customers/999999/statement")).status).toBe(404);

		const tsu = await spoolReport(env.DB, "IBMUSER", "CUSR01", "CREDIT EXPOSURE", ["A REPORT LINE"]);
		res = await call("GET", `/v1/spool/${tsu}/pdf`);
		expect(res.status).toBe(200);
		expect(checkPdf(res.body)).toBe(1);
		expect(text(res.body)).toContain("(A REPORT LINE) Tj");
		expect((await call("POST", `/v1/spool/${tsu}/pdf`)).status).toBe(405);
	});

	it("runs a long invoice onto more pages", async () => {
		const { invoice } = await getInvoice(env.DB, await billedInvoice("000102"));
		const lines = Array.from({ length: 90 }, (_, i) => ({
			invoice_id: invoice.id, line: i + 1, sku: "BLT-0516", description: "BOLT", quantity: 1, unit_price: 2,
		}));
		const b = invoicePdf({ ...invoice, status: "P", paid: new Date().toISOString() }, lines, await getCustomer(env.DB, "000102"));
		expect(checkPdf(b)).toBeGreaterThan(1);
		expect(text(b)).toContain("CONTINUED ON NEXT PAGE");
		expect(text(b)).toMatch(/\(PAID \d{4}-\d\d-\d\d\) Tj/);
	});

	it("prints statements and letters for every account", async () => {
		const list = await buildStatements(env.DB);
		expect(list.length).toBeGreaterThan(0);
		for (const s of list.slice(0, 3)) checkPdf(statementPdf(s));
		const letter = {
			level: 3, sent: new Date().toISOString(),
			customer: { id: "000101", name: "A", address: "B", city: "C", state: "NY", zip: "1" },
			invoices: [{ id: "INV00001", po_number: "X", billed: "2026-01-01T00:00:00Z", days: 90, total: 50 }],
		};
		const b = letterPdf(letter);
		checkPdf(b);
		expect(text(b)).toContain("(FINAL NOTICE) Tj");
		expect(text(b)).toContain("(ACCOUNT ON HOLD) Tj");
	});
});

describe("archive", () => {
	it("moves old output to R2, lists it, serves its files and restores it", async () => {
		const id = await spoolReport(env.DB, "IBMUSER", "CUSR01", "OLD REPORT", ["LINE ONE", "LINE TWO"]);
		const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
		await env.DB.prepare("UPDATE spool SET created = ? WHERE id = ?").bind(old, id).run();
		const fresh = await spoolReport(env.DB, "IBMUSER", "CUSR01", "NEW REPORT", ["NEW"]);

		const done = await archiveSpool(env.DB, env.ARCHIVE, "CUSARCH");
		const key = `spool/${old.slice(0, 7)}/${id}`;
		expect(done.map((e) => e.key)).toContain(key);
		expect(done.map((e) => e.ref)).not.toContain(fresh);
		expect((await call("GET", `/v1/spool/${id}`)).status).toBe(404);
		expect((await call("GET", `/v1/spool/${fresh}`)).status).toBe(200);

		let res = await call("GET", `/v1/archive?name=${id.toLowerCase()}`);
		expect(res.body).toHaveLength(1);
		expect(res.body[0]).toMatchObject({ key, kind: "L", ref: id, name: "CUSR01", title: "OLD REPORT", lines: 2, created: old });
		expect((await call("GET", "/v1/archive?kind=S&name=" + id)).body).toEqual([]);
		res = await call("GET", `/v1/archive/${key}`);
		expect(res.body.key).toBe(key);
		res = await call("GET", `/v1/archive/${key}.txt`);
		expect(res.body).toBe("LINE ONE\nLINE TWO\n");
		res = await call("GET", `/v1/archive/${key}.pdf`);
		expect(res.disposition).toBe(`inline; filename="${id}.pdf"`);
		checkPdf(res.body);
		expect((await call("GET", "/v1/archive/spool/nosuch.pdf")).status).toBe(404);

		// A second run finds nothing more to do.
		expect((await archiveSpool(env.DB, env.ARCHIVE, "CUSARCH")).map((e) => e.ref)).not.toContain(id);

		res = await call("POST", "/v1/archive/restore", { key });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ id, status: "HELD", lines: 2, created: old });
		expect((await call("GET", `/v1/spool/${id}`)).body.lines).toEqual(["LINE ONE", "LINE TWO"]);
		expect((await call("POST", "/v1/archive/restore", { key })).status).toBe(409);
		expect((await call("POST", "/v1/archive/restore", { key: "spool/nosuch" })).status).toBe(404);
		expect((await call("DELETE", "/v1/archive")).status).toBe(405);
	});

	it("files statements, dunning letters and month-end reports from the jobs", async () => {
		const run = async (name: string, id: string) => {
			await using instance = await introspectWorkflowInstance(env.JOB_RUNNER, id);
			const res = await call("POST", "/v1/jobs", { name });
			expect(res.body.id).toBe(id);
			await instance.waitForStatus("complete");
			return (await call("GET", `/v1/jobs/${id}`)).body;
		};
		const next = async () => {
			const row = await env.DB.prepare("SELECT printf('JOB%05d', value + 1) AS id FROM counters WHERE name = 'job_id'").first<{ id: string }>();
			return row!.id;
		};

		let job = await run("CUSSTMT", await next());
		expect(job.output.join("\n")).toMatch(/(\d+) STATEMENTS PRINTED, \1 FILED IN THE ARCHIVE/);
		const stmts = (await call("GET", "/v1/archive?kind=S")).body;
		expect(stmts.length).toBeGreaterThan(0);
		expect(stmts[0].key).toMatch(/^statements\/\d{4}-\d\d\/\d{6}$/);
		checkPdf((await call("GET", `/v1/archive/${stmts[0].key}.pdf`)).body);
		// Each statement is mailed, once a month.
		expect(job.output.join("\n")).toMatch(new RegExp(`${stmts.length} MAILED TO JUSTIN.FRANK@ME.COM, 0 FAILED`));
		const mail = (await call("GET", `/v1/mail?ref=${stmts[0].ref}`)).body;
		expect(mail[0]).toMatchObject({ direction: "O", status: "SENT", archive_key: stmts[0].key });
		expect((await call("GET", `/v1/mail/${mail[0].seq}`)).body.seq).toBe(mail[0].seq);
		job = await run("CUSSTMT", await next());
		expect(job.output.join("\n")).toContain("NOTHING NEW TO MAIL");

		job = await run("CUSCLOSE", await next());
		expect(job.job.rc).not.toBe("ABEND");
		expect(job.output.join("\n")).toContain("MONTH-END REPORTS FOR");
		const monthEnd = (await call("GET", "/v1/archive?kind=M")).body.map((e: { key: string }) => e.key);
		expect(monthEnd).toEqual(expect.arrayContaining([expect.stringMatching(/^month-end\/\d{4}-\d\d\/TRIALBAL$/)]));
		const tb = (await call("GET", `/v1/archive/${monthEnd.find((k: string) => k.endsWith("TRIALBAL"))}.txt`)).body;
		expect(tb).toContain("TRIAL BALANCE AS OF PERIOD");

		// An invoice billed 70 days ago gets a second notice, filed as a PDF.
		const cust = (await env.DB.prepare("SELECT id FROM customers WHERE status = 'A' AND id > '000102' ORDER BY id LIMIT 1").first<{ id: string }>())!.id;
		const id = await billedInvoice(cust);
		await env.DB.prepare("UPDATE invoices SET billed = ? WHERE id = ?").bind(new Date(Date.now() - 70 * 86_400_000).toISOString(), id).run();
		const res = await dunningLetters(env.DB, { name: "CUSDUNN", submitted_by: "IBMUSER" }, env.ARCHIVE);
		expect(res.lines.join("\n")).toContain(id);
		const letters = (await call("GET", `/v1/archive?kind=D&name=${cust}`)).body;
		expect(letters[0]).toMatchObject({ ref: cust, name: "CUSDUNN" });
		expect(letters[0].key).toMatch(new RegExp(`^letters/\\d{4}-\\d\\d-\\d\\d/${cust}-L2$`));
		expect(text((await call("GET", `/v1/archive/${letters[0].key}.pdf`)).body)).toContain("(SECOND NOTICE) Tj");
	});
});
