import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { bill } from "../src/edi";
import { addLine, createInvoice } from "../src/invoices";
import { commissionStatements, type Job } from "../src/jobs";
import { mailStep } from "../src/mail";
import { commissionMonth, commissionStatement, listSalespeople, salesBy, saveSalesperson } from "../src/sales";
import type { Env } from "../src/index";
import { shipInvoice } from "./ship";

const db = env.DB;
const month = () => new Date().toISOString().slice(0, 7);

describe("quotas and commission statements", () => {
	it("reports the month just ended early in a month, else the month so far", () => {
		expect(commissionMonth(new Date("2026-11-01T06:00:00Z"))).toBe("2026-10");
		expect(commissionMonth(new Date("2026-01-03T06:00:00Z"))).toBe("2025-12");
		expect(commissionMonth(new Date("2026-10-26T12:00:00Z"))).toBe("2026-10");
	});

	it("prints a statement against quota and files and mails one per salesperson", async () => {
		// GREENSBORO, NC is in SO, sold by S03 at 4%; no NC tax in the table.
		const inv = await createInvoice(db, "IBMUSER", "000116");
		await addLine(db, inv.id, "SAF-GLV", 15); // $780
		await shipInvoice(db, inv.id);
		await bill(db, env.TABLES, "IBMUSER", inv.id);

		const sp = (await listSalespeople(db)).find((s) => s.id === "S03")!;
		expect(sp.quota).toBe(35000);
		const st = await commissionStatement(db, sp, month());
		expect(st.lines[0]).toBe(`COMMISSION STATEMENT   S03 ROSA DELGADO   MONTH ${month()}`);
		expect(st.lines.find((l) => l.startsWith(inv.id))).toMatch(/000116 PIEDMONT TEXTILES .* \$780 +\$31$/);
		expect(st.commission).toBeGreaterThanOrEqual(31);
		expect(st.lines.at(-1)).toMatch(/^MONTHLY QUOTA \$35,000   ACTUAL \$[\d,]+   [\d.]+% OF QUOTA$/);

		const row = (await salesBy(db, "S", month())).find((r) => r.key === "S03")!;
		expect(row).toMatchObject({ quota: 35000, commission: st.commission, net: st.net });

		const job = { id: "JOB09998", name: "CUSCOMM", submitted_by: "IBMUSER", started: new Date(Date.now() - 1000).toISOString(), submitted: "" } as Job;
		const run = await commissionStatements(db, job, env as unknown as Env);
		expect(run.rc).toBe(0);
		const filed = await db.prepare("SELECT key, kind, ref FROM archive WHERE archived_by = 'CUSCOMM' ORDER BY key").all<{ key: string; ref: string }>();
		expect(filed.results.map((r) => r.ref)).toEqual(["S01", "S02", "S03", "S04"]);
		expect(filed.results[0].key).toMatch(new RegExp(`^commissions/${month()}/S01(-\\d\\d)?$`));

		const send = vi.fn(async () => ({ messageId: "<c@parkerfrank.com>" }));
		const mailed = await mailStep("M")(db, job, { ...env, MAIL: { send } as unknown as SendEmail } as unknown as Env);
		expect(mailed.lines.at(-1)).toBe("4 MAILED TO JUSTIN.FRANK@ME.COM, 0 FAILED");
	});

	it("keeps a quota on the salesperson", async () => {
		expect(await saveSalesperson(db, "IBMUSER", "S04", { name: "TOM WHITEHORSE", comm: "3", status: "A", quota: "$45,000" }))
			.toMatchObject({ quota: 45000 });
		await expect(saveSalesperson(db, "IBMUSER", "S04", { name: "TOM WHITEHORSE", comm: "3", status: "A", quota: "lots" }))
			.rejects.toThrow("whole number of dollars");
	});
});
