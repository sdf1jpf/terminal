import { introspectWorkflowInstance } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accessJWT } from "./access";
import { agedBalances, creditWatchList, holdOverLimit, type Job } from "../src/jobs";

const worker = (exports as unknown as { default: Fetcher }).default;

async function call(method: string, path: string, body?: unknown) {
	const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await accessJWT() };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await worker.fetch(`https://api.test${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: await res.json<any>() };
}

const job = { id: "JOB00099", name: "CUSCRREV" } as Job;

describe("batch jobs", () => {
	it("submits a job and runs it to OUTPUT through the queue and workflow", async () => {
		await using instance = await introspectWorkflowInstance(env.JOB_RUNNER, "JOB00001");
		const res = await call("POST", "/v1/jobs", { name: "cusaging" });
		expect(res.status).toBe(202);
		expect(res.body).toMatchObject({ id: "JOB00001", name: "CUSAGING", status: "QUEUED", submitted_by: "IBMUSER" });

		await instance.waitForStatus("complete");
		const { body } = await call("GET", "/v1/jobs/JOB00001");
		expect(body.job).toMatchObject({ status: "OUTPUT", rc: "0004" });
		expect(body.output).toContain("IEF142I CUSAGING STEP010 - STEP WAS EXECUTED - COND CODE 0004");
		expect(body.output.at(-1)).toBe("$HASP395 CUSAGING ENDED - RC=0004");

		const list = await call("GET", "/v1/jobs");
		expect(list.body[0].id).toBe("JOB00001");
	});

	it("refuses jobs that are not in the library", async () => {
		const res = await call("POST", "/v1/jobs", { name: "IEFBR14" });
		expect(res.status).toBe(422);
		expect(res.body.error.field).toBe("job");
		expect((await call("GET", "/v1/jobs/JOB99999")).status).toBe(404);
	});

	it("ages balances by unpaid invoices, newest first", async () => {
		await call("POST", "/v1/customers/000104/transactions", { type: "I", amount: 300 });
		await call("POST", "/v1/customers/000104/transactions", { type: "I", amount: 200 });
		await call("POST", "/v1/customers/000104/transactions", { type: "P", amount: 100 });
		// The two invoices are old: 45 and 120 days.
		const day = 86_400_000;
		await env.DB.prepare("UPDATE transactions SET posted = ? WHERE customer_id = '000104' AND amount = 300")
			.bind(new Date(Date.now() - 120 * day).toISOString()).run();
		await env.DB.prepare("UPDATE transactions SET posted = ? WHERE customer_id = '000104' AND amount = 200")
			.bind(new Date(Date.now() - 45 * day).toISOString()).run();

		const { lines } = await agedBalances(env.DB);
		// Balance 400: the 200 invoice is all unpaid (31-60), 200 of the 300 one (over 90).
		const row = lines.find((l) => l.startsWith("000104"))!;
		expect(row.split(/\s{2,}|\s(?=\$)/).filter((s) => s.startsWith("$"))).toEqual(["$200", "$200", "$400"]);
	});

	it("holds accounts over their limit, once, and records it", async () => {
		await env.DB.prepare("UPDATE customers SET balance = 26000 WHERE id = '000102'").run();
		const watch = await creditWatchList(env.DB);
		expect(watch.lines.some((l) => l.includes("000102"))).toBe(true);

		const first = await holdOverLimit(env.DB, job);
		expect(first.rc).toBe(4);
		expect(first.lines.at(-1)).toBe("1 ACCOUNTS PLACED ON HOLD");
		const again = await holdOverLimit(env.DB, job);
		expect(again).toMatchObject({ rc: 0 });

		const { body } = await call("GET", "/v1/customers/000102/history");
		expect(body[0]).toMatchObject({ action: "CHANGE", field: "STATUS", old_value: "A", new_value: "H", by: "CUSCRREV" });
		expect(body.filter((c: { field: string }) => c.field === "STATUS")).toHaveLength(1);
	});
});
