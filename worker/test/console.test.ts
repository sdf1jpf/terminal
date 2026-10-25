import { introspectWorkflowInstance } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { matches, nextRun, parseCron } from "../src/cron";
import { runSchedules } from "../src/scheduler";
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
	return { status: res.status, body: res.status === 204 ? null : await res.json<any>() };
}

async function nextJobID(): Promise<string> {
	const row = await env.DB.prepare("SELECT value FROM counters WHERE name = 'job_id'").first<{ value: number }>();
	return `JOB${String(row!.value + 1).padStart(5, "0")}`;
}

const at = (s: string) => new Date(s);

describe("cron expressions", () => {
	it("matches the five fields in UTC", () => {
		const c = parseCron("15 6 * * *");
		expect(matches(c, at("2026-10-26T06:15:42Z"))).toBe(true);
		expect(matches(c, at("2026-10-26T06:16:00Z"))).toBe(false);
		expect(nextRun(c, at("2026-10-26T06:15:00Z"))!.toISOString()).toBe("2026-10-27T06:15:00.000Z");
		expect(nextRun(c, at("2026-10-26T05:00:00Z"))!.toISOString()).toBe("2026-10-26T06:15:00.000Z");
	});

	it("takes ranges, steps, lists, names and shorthands", () => {
		expect([...parseCron("*/20 * * * *").minute]).toEqual([0, 20, 40]);
		expect([...parseCron("5/20 * * * *").minute]).toEqual([5, 25, 45]);
		expect([...parseCron("0 9-17/4 * * *").hour]).toEqual([9, 13, 17]);
		expect([...parseCron("0 0 * * mon-fri").dow]).toEqual([1, 2, 3, 4, 5]);
		expect([...parseCron("0 0 * * 7").dow]).toEqual([0]);
		expect([...parseCron("0 0 1,15 jan,jul *").month]).toEqual([1, 7]);
		expect(nextRun(parseCron("@monthly"), at("2026-10-25T21:00:00Z"))!.toISOString()).toBe("2026-11-01T00:00:00.000Z");
		// Saturday 2026-10-31 is a weekend day, so the weekday cron skips to Monday.
		expect(nextRun(parseCron("0 6 * * 1-5"), at("2026-10-30T07:00:00Z"))!.toISOString()).toBe("2026-11-02T06:00:00.000Z");
		// Both day fields restricted: either one runs (the 1st, or a Sunday).
		expect(nextRun(parseCron("0 0 1 * 0"), at("2026-10-25T01:00:00Z"))!.toISOString()).toBe("2026-11-01T00:00:00.000Z");
		expect(nextRun(parseCron("0 0 30 2 *"), at("2026-10-25T00:00:00Z"))).toBeUndefined();
	});

	it("rejects bad expressions", () => {
		for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "0 0 0 * *", "*/0 * * * *", "a * * * *", "5-1 * * * *", "* * * * * *"]) {
			expect(() => parseCron(bad), bad).toThrow();
		}
	});
});

describe("job scheduler", () => {
	it("submits the jobs that are due, once a minute", async () => {
		const id = await nextJobID();
		await using instance = await introspectWorkflowInstance(env.JOB_RUNNER, id);
		// 06:15 UTC: only CUSAGING is due; EDISIM (hourly) is held.
		const jobs = await runSchedules(env, at("2026-10-26T06:15:07Z"));
		expect(jobs.map((j) => [j.id, j.name, j.submitted_by])).toEqual([[id, "CUSAGING", "SCHEDULR"]]);
		// The trigger firing again for the same minute submits nothing.
		expect(await runSchedules(env, at("2026-10-26T06:15:30Z"))).toEqual([]);
		await instance.waitForStatus("complete");

		const { body } = await call("GET", "/v1/schedules");
		expect(body.find((s: { name: string }) => s.name === "CUSAGING")).toMatchObject({
			last_due: "2026-10-26T06:15:00.000Z", last_job: id, enabled: 1,
		});
		const log = (await call("GET", "/v1/syslog?limit=20")).body.map((l: { text: string }) => l.text);
		expect(log).toContain(`CUS0701I CUSAGING RELEASED BY SCHEDULE 15 6 * * * - ${id}`);
		expect(log).toContain("$HASP373 CUSAGING STARTED");
		expect(log[0]).toBe("$HASP395 CUSAGING ENDED - RC=0004");
	});

	it("adds, holds and deletes schedules over REST", async () => {
		let res = await call("PUT", "/v1/schedules/cusstmt", { cron: "0  7 1 * *" });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ name: "CUSSTMT", cron: "0 7 1 * *", enabled: 1, updated_by: "IBMUSER" });
		expect(res.body.next_run).toMatch(/-01T07:00:00\.000Z$/);

		res = await call("PUT", "/v1/schedules/CUSSTMT", { cron: "0 7 1 * *", enabled: false });
		expect(res.body.enabled).toBe(0);
		expect(res.body.next_run).toBeUndefined();
		expect(await runSchedules(env, at("2026-11-01T07:00:00Z"))).toEqual([]);

		res = await call("PUT", "/v1/schedules/IEFBR14", { cron: "* * * * *" });
		expect(res.status).toBe(422);
		expect(res.body.error.field).toBe("job");
		res = await call("PUT", "/v1/schedules/CUSSTMT", { cron: "0 25 * * *" });
		expect(res.status).toBe(422);
		expect(res.body.error).toMatchObject({ field: "cron", message: "cron hour 25 is not 0-23" });

		expect((await call("DELETE", "/v1/schedules/CUSSTMT")).status).toBe(204);
		expect((await call("DELETE", "/v1/schedules/CUSSTMT")).status).toBe(404);
		expect((await call("POST", "/v1/schedules")).status).toBe(405);
	});
});
