import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { listingPageHtml, screenHtml, snapScreen } from "../src/snapshot";
import { spoolReport } from "../src/spool";
import { accessJWT } from "./access";

// fakeBrowser stands in for the Browser Rendering binding, which only runs
// on Cloudflare: it answers each quick action with a small file.
function fakeBrowser(status = 200) {
	const quickAction = vi.fn(async (action: string, _opts: unknown) =>
		new Response(status === 200 ? (action === "pdf" ? "%PDF-1.7 fake" : "\x89PNG fake") : "browser time limit", { status }));
	return { env: { ...env, BROWSER: { quickAction } as unknown as BrowserRun } as Env, quickAction };
}

async function call(e: Env, method: string, path: string, body?: unknown) {
	const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await accessJWT() };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const req = new Request(`https://api.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	return worker.fetch(req, e, createExecutionContext());
}

const screen = {
	rows: 24, cols: 80,
	fields: [
		{ row: 1, col: 2, text: "CUSM00", color: "blue" },
		{ row: 1, col: 30, text: "CUSTOMER <SYSTEM> & CO", bright: true },
		{ row: 4, col: 2, text: "OPTION ===>", color: "green", bright: true },
		{ row: 4, col: 14, text: "1.2     ", input: true, highlight: "underscore" },
		{ row: 6, col: 2, text: "SECRET", input: true, hidden: true },
		{ row: 24, col: 70, text: "WRAPS AROUND", color: "yellow" },
	],
	cursor: { row: 4, col: 17 },
};

describe("screen snapshots", () => {
	it("draws the screen cell by cell, in the 3270 colors", () => {
		const { html, width, height } = screenHtml(snapScreen(screen), "SNAPSHOT CUSM00");
		expect(html).toContain('<span class="c-blue">CUSM00</span>');
		expect(html).toContain('<span class="c-white bright">CUSTOMER &lt;SYSTEM&gt; &amp; CO</span>');
		expect(html).toContain('<span class="c-green ul">1.2</span><span class="c-green ul cursor"> </span>');
		expect(html).not.toContain("SECRET");
		// Rows are the screen's rows; the last field wraps to the top.
		const rows = /<pre>([^]*?)<\/pre>/.exec(html)![1].split("\n");
		expect(rows).toHaveLength(24);
		expect(rows[23]).toContain(">WRAPS AROUN<");
		expect(rows[0].startsWith('<span class="c-yellow">D</span>')).toBe(true);
		expect(width).toBeGreaterThan(80 * 10);
		expect(height).toBeGreaterThan(25 * 20);
	});

	it("refuses screens it cannot draw", () => {
		expect(() => snapScreen({ ...screen, rows: 10 })).toThrow(/rows/);
		expect(() => snapScreen({ ...screen, fields: [{ row: 25, col: 1, text: "X" }] })).toThrow(/off the screen/);
		expect(() => snapScreen({ ...screen, fields: [{ row: 1, col: 1, text: "X", color: "mauve" }] })).toThrow(/color/);
	});

	it("sends the page to the browser and returns the picture", async () => {
		const { env: e, quickAction } = fakeBrowser();
		let res = await call(e, "POST", "/v1/snapshot", { screen, map: "CUSM00", terminal: "TERM0001" });
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(res.headers.get("Content-Disposition")).toMatch(/^inline; filename="CUSM00-\d{12}\.png"$/);
		expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("\x89PNG fake");
		const [action, opts] = quickAction.mock.calls[0] as [string, { html: string; screenshotOptions: { clip: object } }];
		expect(action).toBe("screenshot");
		expect(opts.html).toContain("SNAPSHOT CUSM00  IBMUSER  TERM0001");
		expect(opts.screenshotOptions.clip).toMatchObject({ x: 0, y: 0 });

		res = await call(e, "POST", "/v1/snapshot", { screen, format: "pdf" });
		expect(res.headers.get("Content-Type")).toBe("application/pdf");
		expect(res.headers.get("Content-Disposition")).toMatch(/filename="SCREEN-\d{12}\.pdf"/);
		expect(quickAction.mock.calls[1][0]).toBe("pdf");

		res = await call(e, "POST", "/v1/snapshot", { screen, format: "gif" });
		expect(res.status).toBe(400);
	});

	it("says so when the browser is missing or fails", async () => {
		let res = await call({ ...env, BROWSER: undefined } as Env, "POST", "/v1/snapshot", { screen });
		expect(res.status).toBe(503);
		res = await call(fakeBrowser(429).env, "POST", "/v1/snapshot", { screen });
		expect(res.status).toBe(503);
		expect((await res.json<any>()).error.message).toMatch(/could not draw it: 429 browser time limit/);
	});
});

describe("report pages as pictures", () => {
	it("draws a page of green-bar paper", async () => {
		const lines = Array.from({ length: 130 }, (_, i) => `LINE ${i + 1} <TAG>`);
		const id = await spoolReport(env.DB, "IBMUSER", "CUSRPT1", "A LONG REPORT", lines);
		const p = listingPageHtml({ id, name: "CUSRPT1", title: "A LONG REPORT" }, lines, 1);
		expect(p.pages).toBe(3);
		expect(p.html).toContain("LINE 1 &lt;TAG&gt;");
		expect(() => listingPageHtml({ id, name: "CUSRPT1", title: "A LONG REPORT" }, lines, 4)).toThrow(/no page 4/);

		const { env: e, quickAction } = fakeBrowser();
		const res = await call(e, "GET", `/v1/spool/${id}/png?page=2`);
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Pages")).toBe("3");
		expect(res.headers.get("Content-Disposition")).toBe(`inline; filename="${id}-P2.png"`);
		expect((quickAction.mock.calls[0][1] as { html: string }).html).toContain("LINE 6");
		expect((await call(e, "GET", `/v1/spool/${id}/png?page=9`)).status).toBe(404);
	});
});
