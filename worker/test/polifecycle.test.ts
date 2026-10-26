import { introspectWorkflowInstance } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accessJWT } from "./access";
import { Terminal } from "./term";
import { processInterchange, receive } from "../src/edi";
import { deliverSignals, getFlow, timeline } from "../src/lifecycle";
import { alertPO, lookAtPO } from "../src/polifecycle";
import { addPOLine, cancelPO, createPO, receivePO, sendPO, vendorConfirmation, vendorShipNotice } from "../src/purchasing";

const db = env.DB;
const DAY = 86_400_000;
const worker = (exports as unknown as { default: Fetcher }).default;

async function fromVendor(raw: string) {
	const filed = await receive(db, "TEST", raw);
	return (await processInterchange(db, filed.id))!;
}

const events = async (ref: string) => (await timeline(db, "P", ref)).map((e) => e.event);
const signals = async (ref: string) =>
	(await db.prepare("SELECT what FROM order_signals WHERE kind = 'P' AND ref = ? ORDER BY seq").bind(ref).all<{ what: string }>()).results.map((r) => r.what);

describe("purchase order lifecycle", () => {
	it("follows a PO from 850 to stock, and chases a late vendor", async () => {
		const po = await createPO(db, "IBMUSER", "V00002");
		await addPOLine(db, po.id, "BRG-6204", 10);
		await addPOLine(db, po.id, "CHN-0080", 5);
		expect(await lookAtPO(db, po.id)).toEqual({ wait: 30 * DAY });
		expect((await getFlow(db, "P", po.id))!.next).toBe("SEND TO V00002");

		const { po: sent } = await sendPO(db, po.id);
		const look = await lookAtPO(db, po.id);
		expect(look.wait).toBeGreaterThan(DAY);
		expect((await getFlow(db, "P", po.id))!.next).toMatch(/^855 FROM V00002 BY \d{4}-\d\d-\d\d$/);

		// Three days on with no 855: one expedite alert.
		const later = Date.parse(sent.sent) + 3 * DAY;
		expect(await lookAtPO(db, po.id, later)).toEqual({ alert: "NOACK" });
		await alertPO(db, po.id, "NOACK");
		await alertPO(db, po.id, "NOACK");
		expect(await lookAtPO(db, po.id, later)).toEqual({ wait: 30 * DAY });
		expect((await getFlow(db, "P", po.id))!.next).toBe("855 FROM V00002 - NO 855 CONFIRMATION FROM THE VENDOR");
		const log = await db.prepare("SELECT COUNT(*) AS n FROM syslog WHERE text LIKE ?").bind(`CUS1620W EXPEDITE ${po.id}%`).first<{ n: number }>();
		expect(log!.n).toBe(1);

		await fromVendor(vendorConfirmation("V00002", 801, po.id, new Date(Date.now() + 5 * DAY)));
		expect((await lookAtPO(db, po.id)).wait).toBeGreaterThan(4 * DAY);
		await fromVendor(vendorShipNotice("V00002", 802, po.id));
		await lookAtPO(db, po.id);
		expect((await getFlow(db, "P", po.id))!.next).toMatch(/^THE GOODS BY /);

		await receivePO(db, "IBMUSER", po.id, new Map([[1, 4]]));
		await lookAtPO(db, po.id);
		expect((await getFlow(db, "P", po.id))!.next).toMatch(/^THE REST OF THE GOODS BY /);
		await receivePO(db, "IBMUSER", po.id, "all");
		expect(await lookAtPO(db, po.id)).toEqual({ done: "RECEIVED" });
		expect(await events(po.id)).toEqual([
			"OPENED", "SENT", "EDI 850", "EXPEDITE", "EDI 855", "CONFIRMED", "EDI 856", "IN TRANSIT", "RECEIPT", "RECEIPT", "RECEIPT", "RECEIVED",
		]);
		const received = (await timeline(db, "P", po.id)).at(-1)!;
		expect(received.detail).toBe("IN FULL, 15 UNITS RESTOCKED");
	});

	it("signals each change and ends a cancelled PO", async () => {
		const po = await createPO(db, "IBMUSER", "V00001");
		await addPOLine(db, po.id, "BLT-0516", 1);
		await lookAtPO(db, po.id);
		await cancelPO(db, po.id);
		expect(await signals(po.id)).toEqual(["OPENED", "CANCELLED"]);
		expect(await lookAtPO(db, po.id)).toEqual({ done: "CANCELLED" });
	});

	it("runs as a workflow and shows on the timeline screen and API", async () => {
		const po = await createPO(db, "IBMUSER", "V00003");
		await using instance = await introspectWorkflowInstance(env.ORDER_FLOW, po.id);
		await addPOLine(db, po.id, "HYD-0250", 2);
		await deliverSignals(env);
		await instance.waitForStepResult({ name: "look 1" });
		await sendPO(db, po.id);
		await fromVendor(vendorShipNotice("V00003", 803, po.id));
		await receivePO(db, "IBMUSER", po.id, "all");
		await deliverSignals(env);
		await instance.waitForStatus("complete");
		expect(await getFlow(db, "P", po.id)).toMatchObject({ status: "C", outcome: "RECEIVED" });

		const res = await worker.fetch(`https://api.test/v1/purchase-orders/${po.id}/timeline`, {
			headers: { "Cf-Access-Jwt-Assertion": await accessJWT() },
		});
		expect(res.status).toBe(200);
		expect((await res.json<{ events: { event: string }[] }>()).events.at(-1)!.event).toBe("RECEIVED");

		const t = await Terminal.logon();
		await t.fill("option", `3.5 ${Number(po.id.slice(2))}`).send("ENTER");
		expect(t.scr.map).toBe("CUSL01");
		expect(t.field("id")?.value).toBe(po.id);
		expect(t.row(5)).toContain("COMPLETE - RECEIVED");
		await t.send("PF4");
		expect(t.scr.map).toBe("CUSV02");
	});
});
