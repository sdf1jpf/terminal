import { introspectWorkflowInstance } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accessJWT } from "./access";
import { shipInvoice } from "./ship";
import { Terminal } from "./term";
import { addLine, cancelInvoice, createInvoice, getInvoice, payInvoice } from "../src/invoices";
import {
	billOnShipment, deliverSignals, dun, dunningDue, dunningLevelAt, getFlow, LIFECYCLE, lookAtInvoice, timeline,
} from "../src/lifecycle";

const db = env.DB;
const DAY = 86_400_000;
const worker = (exports as unknown as { default: Fetcher }).default;

async function call(path: string) {
	const res = await worker.fetch(`https://api.test${path}`, { headers: { "Cf-Access-Jwt-Assertion": await accessJWT() } });
	return { status: res.status, body: await res.json<any>() };
}

const signals = async (ref: string) =>
	(await db.prepare("SELECT what FROM order_signals WHERE ref = ? ORDER BY seq").bind(ref).all<{ what: string }>()).results.map((r) => r.what);
const events = async (ref: string) => (await timeline(db, "I", ref)).map((e) => e.event);
const backdate = (id: string, days: number) =>
	db.prepare("UPDATE invoices SET billed = ? WHERE id = ?").bind(new Date(Date.now() - days * DAY).toISOString(), id).run();

describe("dunning dates", () => {
	it("counts net 30, then 30 days more for each notice", () => {
		const billed = "2026-01-01T00:00:00.000Z";
		expect(new Date(dunningDue(billed, 1)).toISOString().slice(0, 10)).toBe("2026-01-31");
		expect(dunningLevelAt(billed, Date.parse("2026-01-30T23:59:00Z"))).toBe(0);
		expect(dunningLevelAt(billed, Date.parse("2026-01-31T00:00:00Z"))).toBe(1);
		expect(dunningLevelAt(billed, dunningDue(billed, 2) - 1)).toBe(1);
		expect(dunningLevelAt(billed, dunningDue(billed, 2))).toBe(2);
		expect(dunningLevelAt(billed, dunningDue(billed, 3) + 400 * DAY)).toBe(3);
	});
});

describe("order lifecycle", () => {
	it("signals every change to an invoice, however it was made", async () => {
		const inv = await createInvoice(db, "IBMUSER", "000117", "SIG-1");
		await addLine(db, inv.id, "BLT-0516", 1);
		await shipInvoice(db, inv.id);
		expect(await signals(inv.id)).toEqual(["OPENED", "RELEASED", "PACKED", "SHIPPED"]);

		// An invoice cancelled before its lifecycle started never gets one.
		const gone = await createInvoice(db, "IBMUSER", "000117", "SIG-2");
		await cancelInvoice(db, gone.id);
		expect(await signals(gone.id)).toEqual(["OPENED", "CANCELLED"]);
		await deliverSignals(env);
		expect(await signals(gone.id)).toEqual([]);
		expect(await getFlow(db, "I", gone.id)).toBeUndefined();
		expect(await env.ORDER_FLOW.get(gone.id).then(() => true, () => false)).toBe(false);
	});

	it("bills on shipment, duns when unpaid and ends when paid", async () => {
		const inv = await createInvoice(db, "IBMUSER", "000119", "LIFE-1");
		await addLine(db, inv.id, "BRG-6204", 2);

		expect(await lookAtInvoice(db, inv.id)).toEqual({ wait: 30 * DAY });
		expect(await getFlow(db, "I", inv.id)).toMatchObject({ status: "W", next: "RELEASE TO THE WAREHOUSE" });

		const { shipment } = await shipInvoice(db, inv.id);
		expect(await lookAtInvoice(db, inv.id)).toEqual({ bill: true });
		expect(await billOnShipment(env, inv.id)).toBe(true);
		expect(await billOnShipment(env, inv.id)).toBe(true); // a second run finds it billed
		const billed = (await getInvoice(db, inv.id)).invoice;
		expect(billed.status).toBe("B");

		const look = await lookAtInvoice(db, inv.id);
		expect(look.wait).toBeGreaterThan(29 * DAY);
		const due = new Date(dunningDue(billed.billed, 1)).toISOString().slice(0, 10);
		expect(await getFlow(db, "I", inv.id)).toMatchObject({ status: "W", next: `PAYMENT DUE ${due}, THEN A REMINDER` });
		expect(await events(inv.id)).toEqual(["OPENED", "RELEASED", "PACKED", "SHIPPED", "BILLED"]);
		const t = await timeline(db, "I", inv.id);
		expect(t.find((e) => e.event === "SHIPPED")).toMatchObject({ key: shipment.id, by: "IBMUSER" });
		expect(t.find((e) => e.event === "BILLED")).toMatchObject({ by: LIFECYCLE, detail: "ON SHIPMENT, POSTED TO THE ACCOUNT", amount: billed.total });

		// Payment is due: a reminder, sent once.
		await backdate(inv.id, 31);
		expect(await lookAtInvoice(db, inv.id)).toEqual({ dun: 1 });
		expect(await dun(env, inv.id, 1)).toBe("REMINDER");
		expect(await dun(env, inv.id, 1)).toBe("REMINDER");
		const letters = await db.prepare("SELECT level, sent_by FROM dunning WHERE invoice_id = ?").bind(inv.id).all();
		expect(letters.results).toEqual([{ level: 1, sent_by: LIFECYCLE }]);
		const filed = await db.prepare("SELECT key FROM archive WHERE kind = 'D' AND name = ? AND key LIKE ?")
			.bind(LIFECYCLE, `%${inv.id}-L1`).first();
		expect(filed).not.toBeNull();
		expect((await lookAtInvoice(db, inv.id)).wait).toBeGreaterThan(0);
		expect((await getFlow(db, "I", inv.id))!.next).toMatch(/^PAYMENT, OR SECOND NOTICE \d{4}-\d\d-\d\d$/);

		// Long past due: straight to the final notice, which holds the account.
		await backdate(inv.id, 95);
		expect(await lookAtInvoice(db, inv.id)).toEqual({ dun: 3 });
		await dun(env, inv.id, 3);
		const cust = await db.prepare("SELECT status FROM customers WHERE id = '000119'").first<{ status: string }>();
		expect(cust!.status).toBe("H");
		await lookAtInvoice(db, inv.id);
		expect(await events(inv.id)).toEqual(expect.arrayContaining(["REMINDER", "FINAL NOTICE", "ON HOLD"]));

		await payInvoice(db, "IBMUSER", inv.id);
		expect(await lookAtInvoice(db, inv.id)).toEqual({ done: "PAID" });
		expect(await getFlow(db, "I", inv.id)).toMatchObject({ status: "C", outcome: "PAID", next: "" });
		expect((await events(inv.id)).at(-1)).toBe("PAID");
	});

	it("holds billing while the customer is on hold", async () => {
		const inv = await createInvoice(db, "IBMUSER", "000120", "HOLD-1");
		await addLine(db, inv.id, "BLT-0516", 1);
		await shipInvoice(db, inv.id);
		await db.prepare("UPDATE customers SET status = 'H' WHERE id = '000120'").run();
		expect(await lookAtInvoice(db, inv.id)).toEqual({ wait: 30 * DAY });
		expect((await getFlow(db, "I", inv.id))!.next).toBe("BILLING HELD - CUSTOMER ON HOLD");
		await db.prepare("DELETE FROM order_signals WHERE ref = ?").bind(inv.id).run();
		// Taking the customer off hold signals its invoices waiting to bill.
		await db.prepare("UPDATE customers SET status = 'A' WHERE id = '000120'").run();
		expect(await signals(inv.id)).toEqual(["CUSTOMER ACTIVE"]);
		expect(await lookAtInvoice(db, inv.id)).toEqual({ bill: true });
	});

	it("records a cancelled shipment and a cancelled invoice", async () => {
		const inv = await createInvoice(db, "IBMUSER", "000121", "UNREL-1");
		await addLine(db, inv.id, "BLT-0516", 1);
		const { release, cancelShipment } = await import("../src/shipping");
		const s = await release(db, "IBMUSER", inv.id);
		await lookAtInvoice(db, inv.id);
		await cancelShipment(db, s.id);
		await lookAtInvoice(db, inv.id);
		expect(await events(inv.id)).toEqual(["OPENED", "RELEASED", "UNRELEASED"]);
		await cancelInvoice(db, inv.id);
		expect(await lookAtInvoice(db, inv.id)).toEqual({ done: "CANCELLED" });
		expect(await getFlow(db, "I", inv.id)).toMatchObject({ status: "C", outcome: "CANCELLED" });
	});

	it("runs as a workflow woken by the outbox", async () => {
		const inv = await createInvoice(db, "IBMUSER", "000122", "WF-1");
		await using instance = await introspectWorkflowInstance(env.ORDER_FLOW, inv.id);
		await addLine(db, inv.id, "BLT-0516", 2);
		await deliverSignals(env);
		expect(await signals(inv.id)).toEqual([]);
		await instance.waitForStepResult({ name: "look 1" });

		await shipInvoice(db, inv.id);
		await deliverSignals(env);
		await instance.waitForStepResult({ name: "look 3" });
		const { invoice } = await getInvoice(db, inv.id);
		expect(invoice.status).toBe("B");
		const posted = await db.prepare("SELECT posted_by FROM transactions WHERE reference = ? AND type = 'I'").bind(inv.id).first();
		expect(posted).toEqual({ posted_by: LIFECYCLE });

		await payInvoice(db, "IBMUSER", inv.id);
		await deliverSignals(env);
		await instance.waitForStatus("complete");
		expect(await getFlow(db, "I", inv.id)).toMatchObject({ status: "C", outcome: "PAID" });

		const res = await call(`/v1/invoices/${inv.id}/timeline`);
		expect(res.status).toBe(200);
		expect(res.body.flow).toMatchObject({ status: "C", outcome: "PAID" });
		expect(res.body.events.map((e: { event: string }) => e.event)).toEqual(["OPENED", "RELEASED", "PACKED", "SHIPPED", "BILLED", "PAID"]);
		expect((await call("/v1/invoices/INV99999/timeline")).status).toBe(404);
	});

	it("shows the timeline on CUSL01, from the menu and the invoice list", async () => {
		const inv = await createInvoice(db, "IBMUSER", "000121", "SCR-1");
		await addLine(db, inv.id, "BLT-0516", 1);
		const t = await Terminal.logon();
		await t.fill("option", "2.4 " + inv.id.slice(3)).send("ENTER");
		expect(t.scr.map).toBe("CUSL01");
		expect(t.row(5)).toContain("STARTING");
		expect(t.row(7)).toContain("1 CHANGE NOT YET SEEN BY THE LIFECYCLE");

		await lookAtInvoice(db, inv.id);
		await t.send("PF5");
		expect(t.row(5)).toContain("WAITING");
		expect(t.row(6)).toContain("RELEASE TO THE WAREHOUSE");
		expect(t.row(11)).toMatch(/^\s+1 \d{4}-\d\d-\d\d \d\d:\d\d OPENED\s+FOR 000121 UNITED BOLT & NUT/);
		await t.send("PF4");
		expect(t.scr.map).toBe("CUSI02");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSL01");

		await t.fill("id", "99999").send("ENTER");
		expect(t.message).toBe("CUS1610W INV99999 HAS NO LIFECYCLE");

		await t.send("PF3");
		await t.fill("option", "2.1").send("ENTER");
		await t.fill("sel:" + inv.id, "t").send("ENTER");
		expect(t.scr.map).toBe("CUSL01");
		expect(t.field("id")?.value).toBe(inv.id);
	});
});
