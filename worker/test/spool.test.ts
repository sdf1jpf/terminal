import { introspectWorkflowInstance } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { printText, spoolReport, type Output } from "../src/spool";
import { accessJWT } from "./access";

const worker = (exports as unknown as { default: Fetcher }).default;

async function call(method: string, path: string, body?: unknown) {
	const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await accessJWT() };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await worker.fetch(`https://api.test${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const type = res.headers.get("Content-Type") ?? "";
	return { status: res.status, body: res.status === 204 ? null : type.startsWith("application/json") ? await res.json<any>() : await res.text() };
}

describe("print spool", () => {
	it("holds a job's output, prints it, and purges it with the job", async () => {
		await using instance = await introspectWorkflowInstance(env.JOB_RUNNER, "JOB00001");
		expect((await call("POST", "/v1/jobs", { name: "CUSAGING" })).status).toBe(202);
		await instance.waitForStatus("complete");

		let res = await call("GET", "/v1/spool?name=cus");
		expect(res.body[0]).toMatchObject({
			id: "JOB00001", name: "CUSAGING", owner: "IBMUSER", title: "AGED BALANCES REPORT", status: "HELD", copies: 0,
		});
		const n = res.body[0].lines;
		expect((await call("GET", "/v1/spool?name=EDI")).body).toEqual([]);

		res = await call("GET", "/v1/spool/job00001");
		expect(res.body.lines).toHaveLength(n);
		expect(res.body.lines.at(-1)).toBe("$HASP395 CUSAGING ENDED - RC=0004");
		// The job's output listing is the same lines.
		expect((await call("GET", "/v1/jobs/JOB00001")).body.output).toEqual(res.body.lines);

		res = await call("POST", "/v1/spool/JOB00001/print");
		expect(res.body).toMatchObject({ status: "PRINTED", copies: 1, printed_by: "IBMUSER" });
		res = await call("POST", "/v1/spool/JOB00001/print");
		expect(res.body.copies).toBe(2);
		const log = (await call("GET", "/v1/syslog?limit=5")).body.map((l: { text: string }) => l.text);
		expect(log[0]).toBe(`$HASP150 CUSAGING ON PRT1 ${n} LINES FOR IBMUSER`);

		res = await call("GET", "/v1/spool/JOB00001/print");
		expect(res.status).toBe(200);
		expect(res.body).toMatch(/^CUSAGING JOB00001  AGED BALANCES REPORT +PAGE    1\n/);

		expect((await call("DELETE", "/v1/spool/JOB00001")).status).toBe(204);
		expect((await call("GET", "/v1/spool/JOB00001")).status).toBe(404);
		expect((await call("GET", "/v1/jobs/JOB00001")).status).toBe(404);
		expect((await call("DELETE", "/v1/spool/JOB00001")).status).toBe(404);
		expect((await call("POST", "/v1/spool/JOB00001/print")).status).toBe(404);
		expect((await call("PUT", "/v1/spool/JOB00001")).status).toBe(405);
	});

	it("gives reports printed online a TSU ID", async () => {
		const id = await spoolReport(env.DB, "IBMUSER", "CUSR01", "CREDIT EXPOSURE SUMMARY", ["A", "B"]);
		expect(id).toMatch(/^TSU\d{5}$/);
		const { body } = await call("GET", `/v1/spool/${id}`);
		expect(body).toMatchObject({ output: { name: "CUSR01", status: "HELD", lines: 2 }, lines: ["A", "B"] });
	});

	it("pages a listing for the printer", () => {
		const o = { id: "JOB00009", name: "CUSSTMT", title: "CUSTOMER STATEMENTS" } as Output;
		const text = printText(o, Array.from({ length: 100 }, (_, i) => `LINE ${i + 1}`));
		const pages = text.split("\f");
		expect(pages).toHaveLength(2);
		expect(pages[0].trimEnd().split("\n")).toHaveLength(60);
		expect(pages[1]).toMatch(/^CUSSTMT  JOB00009  CUSTOMER STATEMENTS +PAGE    2\n\n\nLINE 58\n/);
		expect(text.endsWith("LINE 100\n")).toBe(true);
	});
});
