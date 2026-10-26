import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { putArchive, type Entry } from "../src/archive";
import { letterPdf } from "../src/documents";
import worker, { type Env } from "../src/index";
import { listMail, mailDocument, mailStep } from "../src/mail";
import { addPOLine, createPO, getPO, sendPO } from "../src/purchasing";
import type { Job } from "../src/jobs";

const letter = {
	level: 1, sent: new Date().toISOString(),
	customer: { id: "000104", name: "A", address: "B", city: "C", state: "NY", zip: "1" },
	invoices: [{ id: "INV00009", po_number: "X", billed: "2026-01-01T00:00:00Z", days: 40, total: 50 }],
};

async function file(key: string, by = "CUSDUNN"): Promise<Entry> {
	return putArchive(env.DB, env.ARCHIVE, {
		key, kind: "D", ref: "000104", name: by, title: "REMINDER A", owner: "IBMUSER", created: letter.sent, archived_by: by,
	}, ["A LETTER"], letterPdf(letter));
}

// fakeMail stands in for the send_email binding.
function fakeMail(fail = false) {
	const send = vi.fn(async (_m: unknown) => {
		if (fail) throw new Error("destination address not verified");
		return { messageId: "<abc@parkerfrank.com>" };
	});
	return { env: { ...env, MAIL: { send } as unknown as SendEmail } as Env, send };
}

describe("outbound mail", () => {
	it("mails an archived document once, with its PDF attached", async () => {
		const e = await file("letters/2026-10-26/000104-L1");
		const { env: e2, send } = fakeMail();
		const m = await mailDocument(e2, e, "IBMUSER");
		expect(m).toMatchObject({
			direction: "O", status: "SENT", sender: "billing@parkerfrank.com", recipient: "justin.frank@me.com",
			subject: "DUNNING 000104 - REMINDER A", ref: "000104", archive_key: e.key, message_id: "<abc@parkerfrank.com>",
		});
		const sent = send.mock.calls[0][0] as { to: string; attachments: { filename: string; type: string; content: ArrayBuffer }[] };
		expect(sent.to).toBe("justin.frank@me.com");
		expect(sent.attachments[0]).toMatchObject({ filename: "2026-10-26-000104-L1.pdf", type: "application/pdf" });
		expect(new TextDecoder().decode(sent.attachments[0].content).startsWith("%PDF-1.4")).toBe(true);

		expect(await mailDocument(e2, e, "IBMUSER")).toBeUndefined();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("records a failure, and the job step's condition code shows it", async () => {
		const job = { id: "JOB09999", name: "CUSDUNN", started: new Date(Date.now() - 1000).toISOString(), submitted: "" } as Job;
		await file("letters/2026-10-26/000104-L2");
		const bad = fakeMail(true);
		let res = await mailStep("D")(env.DB, job, bad.env);
		expect(res.rc).toBe(8);
		expect(res.lines.join("\n")).toContain("FAILED 000104");
		expect((await listMail(env.DB, "000104"))[0]).toMatchObject({ status: "FAILED", detail: "destination address not verified" });

		// A later run tries again, since nothing was sent.
		const good = fakeMail();
		res = await mailStep("D")(env.DB, job, good.env);
		expect(res.rc).toBe(0);
		expect(res.lines.at(-1)).toBe("1 MAILED TO JUSTIN.FRANK@ME.COM, 0 FAILED");

		res = await mailStep("D")(env.DB, job, { ...env, MAIL: undefined } as Env);
		expect(res).toMatchObject({ rc: 4 });
		expect(res.lines.join("\n")).toContain("MAIL IS NOT SET UP");
	});
});

describe("inbound mail", () => {
	const message = (subject: string) => {
		const m = {
			from: "orders@vendor.example", to: "po@parkerfrank.com", headers: new Headers({ subject, "message-id": "<1@vendor>" }),
			raw: new ReadableStream(), rawSize: 0, rejected: "",
			setReject(reason: string) { m.rejected = reason; },
			forward: async () => ({}), reply: async () => ({}),
		};
		return m;
	};
	const deliver = (m: ReturnType<typeof message>) =>
		(worker.email as EmailExportedHandler<Env>)(m as unknown as ForwardableEmailMessage, env, {} as ExecutionContext);

	it("confirms and ships a purchase order from the vendor's mail", async () => {
		const po = await createPO(env.DB, "IBMUSER", "V00001");
		const { results } = await env.DB.prepare("SELECT sku FROM products WHERE vendor = 'V00001' AND status = 'A' LIMIT 1").all<{ sku: string }>();
		await addPOLine(env.DB, po.id, results[0].sku, 5);
		await sendPO(env.DB, po.id);

		let m = message(`Re: ${po.id} confirmed ship 2026-11-05`);
		await deliver(m);
		expect(m.rejected).toBe("");
		expect((await getPO(env.DB, po.id)).po).toMatchObject({ status: "A", ship_date: "2026-11-05" });
		expect((await listMail(env.DB, po.id))[0]).toMatchObject({
			direction: "I", status: "APPLIED", sender: "orders@vendor.example", detail: `${po.id} CONFIRMED, SHIP 2026-11-05`,
		});

		m = message(`${po.id} SHIPPED`);
		await deliver(m);
		expect((await getPO(env.DB, po.id)).po.status).toBe("T");

		m = message(`${po.id} SHIPPED`);
		await deliver(m);
		expect(m.rejected).toMatch(/^Not applied: purchase order PO\d+ is in transit/i);
		expect((await listMail(env.DB, po.id))[0].status).toBe("REJECTED");
	});

	it("rejects mail it does not understand", async () => {
		const m = message("Hello there");
		await deliver(m);
		expect(m.rejected).toMatch(/^Not understood/);
		m.rejected = "";
		const n = message("PO99999 SHIPPED");
		await deliver(n);
		expect(n.rejected).toBe("Not applied: purchase order PO99999 is not on file.");
	});
});
