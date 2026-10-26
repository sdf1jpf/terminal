import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { abendCode, tranOf } from "../src/cics";
import { HttpError } from "../src/http";
import { cicsWrap } from "../src/screens/cics";
import type { Program } from "../src/screens/program";
import type { Ctx } from "../src/screens/screen";
import { Terminal } from "./term";

const text = (t: Terminal) => Array.from({ length: t.scr.rows }, (_, i) => t.row(i + 1)).join("\n");

async function stats(id: string) {
	return env.DB.prepare("SELECT * FROM cics_transactions WHERE tranid = ?").bind(id).first<any>();
}

describe("CICS transactions", () => {
	it("starts a transaction by its ID from the clear screen", async () => {
		const t = await Terminal.logon();
		await t.send("CLEAR");
		expect(t.scr.map).toBe("DFHCLEAR");
		await t.fill("tran", "XYZZ").send("ENTER");
		expect(t.message).toContain("DFHAC2001 TRANSACTION 'XYZZ' IS NOT RECOGNIZED");
		await t.fill("tran", "CINQ 000101").send("ENTER");
		expect(t.scr.map).toBe("CUSM02");
		expect(text(t)).toContain("ACME TOOL & DIE");
		expect((await stats("CINQ")).uses).toBeGreaterThanOrEqual(1);
		// PF3 returns to the menu the option is on.
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM10");
	});

	it("starts a transaction typed on a menu", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "ORDR").send("ENTER");
		expect(t.scr.map).toBe("CUSI01");
	});

	it("disables and enables transactions with CEMT", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "CEMT S TRAN(ORDR) DIS").send("ENTER");
		expect(t.scr.map).toBe("DFHEMTD");
		expect(t.message).toContain("NORMAL - 1 TRANSACTION DISABLED");
		expect(t.field("st0")?.value).toBe("Dis");

		await t.fill("cmd", "S TRAN(CEMT) DIS").send("ENTER");
		expect(t.message).toContain("NOT-AUTH: CEMT");

		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM00");
		await t.fill("option", "ORDR").send("ENTER");
		expect(t.scr.map).toBe("CUSM00");
		expect(t.message).toContain("DFHAC2008 TRANSACTION ORDR HAS BEEN DISABLED");
		// The fast path runs the same transaction, so it is refused too.
		await t.fill("option", "2.1").send("ENTER");
		expect(t.message).toContain("DFHAC2008");

		// Overtype the status to enable it again.
		await t.fill("option", "CEMT I TRAN(ORDR)").send("ENTER");
		expect(text(t)).toContain("Tra(ORDR) Pro(CUSINV  )");
		await t.fill("st0", "ENA").send("ENTER");
		expect(t.message).toContain("1 TRANSACTION ENABLED");
		await t.send("PF3");
		await t.fill("option", "ORDR").send("ENTER");
		expect(t.scr.map).toBe("CUSI01");
	});

	it("lists tasks and enqueues", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "CEMT I TASK").send("ENTER");
		expect(text(t)).toContain("Use(IBMUSER");
		await t.fill("cmd", "I ENQ").send("ENTER");
		expect(text(t)).toContain("STATUS:  RESULTS");
		await t.fill("cmd", "FOO").send("ENTER");
		expect(t.message).toContain("DFHEM0101");
	});

	it("stops each step on CEDF and traces it to a TS queue", async () => {
		const t = new Terminal((await Terminal.logon()).token, 24, 80, "TERM0042");
		await t.send("START");
		await t.send("CLEAR");
		await t.fill("tran", "CEDF").send("ENTER");
		expect(t.message).toContain("EDF MODE ON");
		await t.fill("tran", "CINQ 000101").send("ENTER");
		expect(t.scr.map).toBe("DFHEDFD");
		const edf = text(t);
		expect(edf).toContain("TRANSACTION: CINQ  PROGRAM: CUSDTL");
		expect(edf).toContain("EIBTRNID = 'CINQ'");
		expect(edf).toContain("EIBAID   = X'7D'  (ENTER)");
		expect(edf).toContain("EIBTRMID = '0042'");
		await t.send("ENTER");
		expect(t.scr.map).toBe("CUSM02");

		// PF3 ends the EDF session.
		await t.send("PF3");
		expect(t.scr.map).toBe("DFHEDFD");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM10");
		expect(t.message).toContain("EDF SESSION ENDED");
		await t.fill("option", "1").send("ENTER");
		expect(t.scr.map).not.toBe("DFHEDFD");
		await t.send("PF3");

		await t.fill("option", "CEBR CEDF0042").send("ENTER");
		expect(t.scr.map).toBe("DFHEDFBR");
		expect(text(t)).toContain("TOP OF QUEUE");
		expect(text(t)).toMatch(/CINQ ENTER cics -> detail/);
		await t.fill("cmd", "PURGE").send("ENTER");
		expect(t.message).toContain("QUEUE CEDF0042 PURGED - 2 ITEMS DELETED");
		await t.fill("cmd", "LIST").send("ENTER");
		expect(text(t)).toContain("QUEUE     ITEMS");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM10");
	});

	it("signs off with CESF", async () => {
		const t = await Terminal.logon();
		await t.send("CLEAR");
		await t.fill("tran", "CESF").send("ENTER");
		expect(t.logoff).toContain("DFHCE3590 SIGN-OFF IS COMPLETE");
	});
});

describe("abends", () => {
	const ctx = {
		env, db: env.DB, user: "TEST", terminal: "TERM0007", rows: 24, cols: 80, system: "TEST", tzOffset: 0,
		app: { title: "T", prefix: "CUS", system: "TEST" },
	} as unknown as Ctx;
	const crashing = cicsWrap<Record<string, Program<any>>>({
		detail: {
			render: async () => { throw new Error("cannot read properties of undefined"); },
			handle: async () => { throw new HttpError(404, "not_found", "no such customer"); },
		},
	});

	it("names the abend after what the program threw", () => {
		expect(abendCode(new TypeError("x")).code).toBe("ASRA");
		expect(abendCode(new HttpError(404, "not_found", "x")).code).toBe("AEIM");
		expect(abendCode(new HttpError(400, "bad_request", "x")).code).toBe("AEIP");
	});

	it("turns a failed handle into an abend screen back to where it was", async () => {
		const s = { p: "detail", mode: "inquiry", back: { p: "menu" } } as any;
		const next = await crashing.detail.handle(ctx, s, { aid: "ENTER", fields: {}, modified: new Set(), cursorField: "" });
		expect(next).toMatchObject({ p: "abend", tran: "CINQ", code: "AEIM", panel: "detail", back: { p: "detail" } });
		const st = await env.DB.prepare("SELECT abends, last_abend FROM cics_transactions WHERE tranid = 'CINQ'").first<any>();
		expect(st).toMatchObject({ last_abend: "AEIM" });
		expect(st.abends).toBeGreaterThanOrEqual(1);
		const q = await env.DB.prepare("SELECT data FROM cics_tsq WHERE queue = 'CSMT' ORDER BY item DESC").first<{ data: string }>();
		expect(q!.data).toContain("CINQ ABEND AEIM detail: no such customer");
	});

	it("turns a failed render into an abend in place", async () => {
		const s = { p: "detail", mode: "inquiry", back: { p: "menu" } } as any;
		const scr = await crashing.detail.render(ctx, s);
		expect(scr.map).toBe("DFHACABN");
		expect(s).toMatchObject({ p: "abend", tran: "CINQ", code: "ASRA", back: { p: "menu" } });
		expect(s.mode).toBeUndefined();
	});

	it("runs help under the screen it was asked from", () => {
		expect(tranOf({ p: "help", back: { p: "invoice" } })?.id).toBe("ORDR");
		expect(tranOf({ p: "cemt" })).toBeUndefined();
	});
});
