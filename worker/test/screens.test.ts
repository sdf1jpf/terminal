import { introspectWorkflowInstance } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { partnerPO, processInterchange, receive } from "../src/edi";
import { addLine, billInvoice, createInvoice, payInvoice } from "../src/invoices";
import { accessJWT } from "./access";
import { shipInvoice } from "./ship";
import { journal } from "../src/ledger";

const worker = (exports as unknown as { default: Fetcher }).default;

interface Field {
	row: number; col: number; text?: string; name?: string; length?: number; value?: string;
	color?: string; bright?: boolean; numeric?: boolean;
}
interface Screen { map: string; rows: number; cols: number; fields: Field[]; cursor?: { field?: string; row?: number; col?: number } }

async function post(body: unknown, token?: string) {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token) headers["Cf-Access-Jwt-Assertion"] = token;
	const res = await worker.fetch("https://api.test/v1/screen", { method: "POST", headers, body: JSON.stringify(body) });
	return { status: res.status, body: await res.json<any>() };
}

// Terminal plays the part of the Go client: it keeps the commarea, lets the
// test type into fields, and sends AID keys.
class Terminal {
	state = "";
	scr!: Screen;
	vals: Record<string, string> = {};
	modified = new Set<string>();
	cursorField = ""; // the field the cursor is in, sent with the next key
	logoff = "";

	constructor(readonly token: string, public rows = 24, public cols = 80) {}

	static async logon(rows = 24, cols = 80) {
		const t = new Terminal(await accessJWT(), rows, cols);
		await t.send("START");
		return t;
	}

	async send(aid: string) {
		const res = await post({
			v: 1, aid, state: aid === "START" ? undefined : this.state, fields: this.vals,
			modified: [...this.modified], cursor: { row: 1, col: 1, field: this.cursorField },
			rows: this.rows, cols: this.cols, terminal: "TERM0001", system: "TEST",
		}, this.token);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		if (res.body.logoff) {
			this.logoff = res.body.logoff.message;
			return this;
		}
		this.state = res.body.state;
		this.scr = res.body.screen;
		this.vals = {};
		this.modified.clear();
		this.cursorField = "";
		for (const f of this.scr.fields) if (f.name) this.vals[f.name] = f.value ?? "";
		return this;
	}

	fill(...kv: string[]) {
		for (let i = 0; i < kv.length; i += 2) {
			const f = this.scr.fields.find((f) => f.name === kv[i]);
			expect(f, `field ${kv[i]}`).toBeDefined();
			this.vals[kv[i]] = kv[i + 1].toUpperCase();
			this.modified.add(kv[i]);
		}
		return this;
	}

	field(name: string) {
		return this.scr.fields.find((f) => f.name === name);
	}

	// row renders one row of the screen as text.
	row(n: number): string {
		const line = Array(this.scr.cols).fill(" ");
		for (const f of this.scr.fields) {
			if (f.row !== n) continue;
			const s = f.text ?? (f.value ?? "").padEnd(f.length ?? 0);
			for (let i = 0; i < s.length && f.col - 1 + i < line.length; i++) line[f.col - 1 + i] = s[i];
		}
		return line.join("");
	}

	get message() {
		return this.row(this.scr.rows - 1).trim();
	}
}

describe("screen protocol", () => {
	it("requires Access", async () => {
		const res = await post({ v: 1, aid: "START", rows: 24, cols: 80 });
		expect(res.status).toBe(401);
	});

	it("starts at the menu with the Access userid", async () => {
		const t = await Terminal.logon();
		expect(t.scr.map).toBe("CUSM00");
		expect(t.message).toMatch(/^IKJ56455I IBMUSER LOGON IN PROGRESS/);
		expect(t.scr.cursor).toEqual({ field: "option" });
		expect(t.row(t.scr.rows)).toContain("PF3=LOGOFF");
		expect(t.row(2)).toContain("TEST CUSTOMER INFORMATION SYSTEM");
	});

	it("rejects bad requests", async () => {
		const token = await accessJWT();
		expect((await post({ v: 2, aid: "START", rows: 24, cols: 80 }, token)).status).toBe(400);
		expect((await post({ v: 1, aid: "START", rows: 24, cols: 80, pw: "x" }, token)).status).toBe(400);
		const t = await Terminal.logon();
		const res = await post({ v: 1, aid: "PF99", state: t.state, rows: 24, cols: 80 }, token);
		expect(res.status).toBe(400);
	});

	it("goes back to the menu when the commarea is damaged", async () => {
		const t = await Terminal.logon();
		t.state = "garbage";
		await t.send("ENTER");
		expect(t.scr.map).toBe("CUSM00");
		expect(t.message).toMatch(/^CUS0001W/);
	});

	it("logs off", async () => {
		const t = await Terminal.logon();
		await t.send("PF3");
		expect(t.logoff).toMatch(/^IKJ56470I IBMUSER LOGGED OFF AT/);
	});

	it("reports an invalid option and an inactive key", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "99").send("ENTER");
		expect(t.message).toBe("ISPD117E INVALID OPTION 99");
		await t.send("PF6");
		expect(t.message).toBe("CUS0000W PF6 IS NOT ACTIVE ON THIS SCREEN");
	});
});

describe("customer screens", () => {
	it("updates a customer, with validation", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "2 105").send("ENTER");
		expect(t.scr.map).toBe("CUSM02");
		expect(t.row(6)).toContain("EVERGREEN TIMBER CO");

		await t.send("PF4");
		expect(t.row(1)).toContain("CUSTOMER UPDATE");
		await t.fill("zip", "123").send("ENTER");
		expect(t.message).toBe("CUS0233E ZIP CODE MUST BE FIVE DIGITS");
		expect(t.scr.cursor).toEqual({ field: "zip" });
		expect(t.field("zip")?.bright).toBe(true);

		await t.fill("zip", "97402", "name", "evergreen timber").send("ENTER");
		expect(t.message).toBe("CUS0212I CUSTOMER 000105 UPDATED");
		expect(t.row(6)).toContain("EVERGREEN TIMBER ");
		expect(t.row(16)).toMatch(/LAST UPDATED.*BY IBMUSER/);
	});

	it("warns when nothing was changed", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "2 106").send("ENTER");
		await t.send("PF4");
		await t.send("ENTER");
		expect(t.message).toBe("CUS0211W NO FIELDS WERE CHANGED");
	});

	it("detects a conflicting update", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "2 107").send("ENTER");
		await t.send("PF4");

		// Another user changes the record after this one started editing.
		const other = await Terminal.logon();
		await other.fill("option", "2 107").send("ENTER");
		await other.send("PF4");
		await other.fill("phone", "937-555-0199").send("ENTER");
		expect(other.message).toMatch(/UPDATED$/);

		await t.fill("city", "kettering").send("ENTER");
		expect(t.message).toMatch(/^CUS0213E 000107 WAS CHANGED BY ANOTHER USER/);
		expect(t.field("phone")?.value).toBe("937-555-0199");
	});

	it("adds a customer after a server-side edit error", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "3").send("ENTER");
		expect(t.row(1)).toContain("ADD CUSTOMER");
		await t.fill("name", "new co", "city", "reno", "state", "n1", "zip", "89501", "limit", "1000").send("ENTER");
		expect(t.message).toMatch(/^CUS0232E/);
		await t.fill("state", "nv").send("ENTER");
		expect(t.message).toMatch(/^CUS0212I CUSTOMER \d{6} ADDED$/);
		expect(t.row(1)).toContain("CUSTOMER INQUIRY");
	});

	it("says when a customer is not found", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "2 999999").send("ENTER");
		expect(t.message).toBe("CUS0201E CUSTOMER 999999 NOT FOUND");
		expect(t.scr.cursor).toEqual({ field: "id" });
	});

	it("browses, selects and deletes", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "1").send("ENTER");
		expect(t.scr.map).toBe("CUSM01");
		expect(t.row(4)).toContain("ROW 1 TO 13 OF");
		const first = t.scr.cursor?.field ?? "";
		expect(first).toMatch(/^sel:\d{6}$/);

		await t.fill(first, "x").send("ENTER");
		expect(t.message).toBe('CUS0103E INVALID SELECTION CODE "X"');
		expect(t.scr.cursor).toEqual({ field: first });

		await t.fill(first, "d").send("ENTER");
		expect(t.row(1)).toContain("DELETE CUSTOMER");
		await t.send("PF10");
		expect(t.scr.map).toBe("CUSM01");
		expect(t.message).toBe(`CUS0220I CUSTOMER ${first.slice(4)} DELETED`);
		expect(t.field(first)).toBeUndefined();
	});

	it("filters, pages, and returns from help to the same page", async () => {
		const t = await Terminal.logon();
		await t.send("PF4");
		await t.fill("filter", "k").send("ENTER");
		expect(t.row(9)).toContain("KEYSTONE STEEL");
		expect(t.row(10)).toContain("BOTTOM OF DATA");

		await t.send("CLEAR");
		await t.send("PF7");
		expect(t.message).toBe("CUS0101W ALREADY AT TOP OF DATA");
		await t.send("PF8");
		const top = t.row(4);
		expect(top).not.toContain("ROW 1 TO");
		await t.send("PF8");
		expect(t.message).toBe("CUS0102W ALREADY AT BOTTOM OF DATA");

		await t.send("PF1");
		expect(t.scr.map).toBe("CUSH00");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM01");
		expect(t.row(4)).toBe(top);
	});

	it("shows the credit report", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "4").send("ENTER");
		expect(t.scr.map).toBe("CUSR01");
		expect(t.row(4)).toMatch(/CUSTOMERS ON FILE.*\d+/);
		await t.send("PF5");
		expect(t.message).toMatch(/^CUS0301I REPORT REFRESHED AT/);
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM00");
	});
});

describe("activity and history screens", () => {
	it("numbers the event history and shows an event's details by line number", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "5 104").send("ENTER");
		expect(t.scr.map).toBe("CUSM03");
		expect(t.row(1)).toContain("EVENT HISTORY");
		expect(t.row(4)).toContain("DELTA MARINE SUPPLY");
		expect(t.row(11)).toContain("NO EVENTS ON FILE");
		expect(t.scr.cursor).toEqual({ field: "line" });

		const inv = await createInvoice(env.DB, "IBMUSER", "000104", "AUDIT-1");
		await addLine(env.DB, inv.id, "BRG-6310", 4);
		const { shipment } = await shipInvoice(env.DB, inv.id);
		await billInvoice(env.DB, "IBMUSER", inv.id);
		await payInvoice(env.DB, "IBMUSER", inv.id);
		await t.send("ENTER");
		expect(t.row(11)).toMatch(new RegExp(`^ +1 .* PAYMENT  ${inv.id} +-\\$124 IBMUSER`));
		expect(t.row(12)).toMatch(new RegExp(`^ +2 .* BILLED   ${inv.id} +\\$124 IBMUSER`));
		expect(t.row(13)).toMatch(new RegExp(`^ +3 .* SHIPPED  ${shipment.id} TRK PRO`));
		expect(t.row(14)).toMatch(new RegExp(`^ +4 .* RELEASED ${shipment.id} ${inv.id} +IBMUSER`));
		expect(t.row(15)).toMatch(new RegExp(`^ +5 .* OPENED   ${inv.id} PO AUDIT-1`));

		await t.fill("line", "9").send("ENTER");
		expect(t.message).toBe("CUS0246E LINE MUST BE 1 TO 5");
		expect(t.scr.cursor).toEqual({ field: "line" });
		await t.fill("line", "2").send("ENTER");
		expect(t.scr.map).toBe("CUSM05");
		expect(t.row(4)).toContain("LINE 2");
		expect(t.row(6)).toContain("INVOICE BILLED");
		expect(t.row(9)).toContain("$0"); // balance before
		expect(t.row(10)).toContain("$124"); // balance after
		expect(t.row(15)).toContain(`INVOICE ${inv.id}  PAID  PO AUDIT-1  TOTAL $124`);
		expect(t.row(18)).toMatch(/1 BRG-6310 +BALL BEARING 6310-ZZ +4 +\$31 +\$124/);
		await t.send("PF4");
		expect(t.scr.map).toBe("CUSI02");
		await t.send("PF3");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM03");

		await t.fill("line", "3").send("ENTER");
		expect(t.row(6)).toContain("SHIPPED");
		expect(t.row(10)).toMatch(/CARRIER .* TRK +PRO\d+ +1 CTN 10 LB/);
		await t.send("PF6");
		expect(t.scr.map).toBe("CUSS02");
		await t.send("PF3");
		await t.send("PF3");

		await t.fill("line", "5").send("ENTER");
		expect(t.row(6)).toContain("INVOICE OPENED");
		expect(t.row(10)).toContain(`INVOICE ${inv.id}`);
		await t.send("PF3");

		await t.send("PF6");
		expect(t.message).toMatch(/^CUS0000W PF6/);
		await t.send("PF5");
		expect(t.scr.map).toBe("CUSI01");
		expect(t.row(9)).toContain(inv.id);
		await t.send("PF3");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM00");
	});

	it("lists record changes as events", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "2 117").send("ENTER");
		await t.send("PF4");
		await t.fill("city", "montpelier").send("ENTER");
		await t.send("PF5");
		expect(t.scr.map).toBe("CUSM03");
		expect(t.row(11)).toMatch(/^ +1 .* CHANGED  CITY BARRE > MONTPELIER/);
		await t.fill("line", "1").send("ENTER");
		expect(t.row(6)).toContain("RECORD CHANGED");
		expect(t.row(8)).toContain("BARRE");
		expect(t.row(9)).toContain("MONTPELIER");
		expect(t.row(t.scr.rows)).not.toContain("PF4");
	});

	it("keeps the history after the customer is deleted", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "2 102").send("ENTER");
		await t.send("PF4");
		await t.fill("city", "salem").send("ENTER");
		await t.send("PF9");
		await t.send("PF10");
		expect(t.message).toBe("CUS0220I CUSTOMER 000102 DELETED");

		await t.send("PF3");
		await t.fill("option", "5 102").send("ENTER");
		expect(t.scr.map).toBe("CUSM03");
		expect(t.message).toBe("CUS0251I CUSTOMER 000102 HAS BEEN DELETED - HISTORY ONLY");
		expect(t.row(11)).toContain("DELETED  RECORD DELETED");
		expect(t.row(12)).toMatch(/CHANGED  CITY ROANOKE > SALEM/);
		await t.fill("line", "2").send("ENTER");
		expect(t.scr.map).toBe("CUSM05");
		expect(t.row(8)).toContain("ROANOKE");

		// The old option 6 still gets there.
		await t.send("PF3");
		await t.send("PF3");
		await t.fill("option", "6 102").send("ENTER");
		expect(t.scr.map).toBe("CUSM03");
	});

	it("opens from the browse list with A, and H as before", async () => {
		const t = await Terminal.logon();
		await t.send("PF4");
		const first = t.scr.cursor?.field ?? "";
		await t.fill(first, "a").send("ENTER");
		expect(t.scr.map).toBe("CUSM03");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM01");
		await t.fill(first, "h").send("ENTER");
		expect(t.scr.map).toBe("CUSM03");
	});
});

describe("search and field help", () => {
	it("searches the browse list by city, state and status", async () => {
		const t = await Terminal.logon();
		await t.send("PF4");
		await t.fill("state", "or").send("ENTER");
		expect(t.row(4)).toContain("ROW 1 TO 2 OF 2");
		expect(t.row(9)).toContain("000105");
		expect(t.row(10)).toContain("OCEANIC CANNERY");

		await t.fill("state", "", "status", "h", "city", "fre").send("ENTER");
		expect(t.row(4)).toContain("ROW 1 TO 1 OF 1");
		expect(t.row(9)).toContain("REDWOOD ELECTRIC");

		await t.fill("status", "x").send("ENTER");
		expect(t.message).toMatch(/^CUS0105E/);
		expect(t.scr.cursor).toEqual({ field: "status" });

		await t.send("CLEAR");
		expect(t.row(4)).toMatch(/ROW 1 TO 13 OF 2\d/);
	});

	it("explains the field the cursor is in, and goes on to the tutorial", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "8").send("ENTER");
		t.cursorField = "filter";
		await t.send("PF1");
		expect(t.scr.map).toBe("CUSH01");
		expect(t.row(1)).toContain("HELP - SKU STARTS WITH");
		await t.send("PF1");
		expect(t.scr.map).toBe("CUSH00");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSP01");

		// Browse's status field is a search, so its help says so.
		await t.send("PF3");
		await t.send("PF4");
		t.cursorField = "status";
		await t.send("PF1");
		expect(t.row(4)).toContain("Lists only the customers with this status");
		await t.send("PF3");
		// Outside a field PF1 is the tutorial.
		await t.send("PF1");
		expect(t.scr.map).toBe("CUSH00");
	});
});

describe("product screens", () => {
	it("lists products, flags low stock, and adds and updates one", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "8").send("ENTER");
		expect(t.scr.map).toBe("CUSP01");
		expect(t.row(9)).toContain("BLT-0516");
		const grs = t.scr.fields.find((f) => f.text?.startsWith("GRS-EP2"));
		expect(grs?.color).toBe("yellow");
		expect(grs?.text).toMatch(/LOW$/);

		await t.send("PF5");
		expect(t.scr.map).toBe("CUSP02");
		await t.fill("sku", "gsk-100", "desc", "flange gasket", "price", "4", "onhand", "x", "reorder", "50", "status", "a").send("ENTER");
		expect(t.message).toMatch(/^CUS0413E/);
		await t.fill("onhand", "200").send("ENTER");
		expect(t.message).toBe("CUS0407I PRODUCT GSK-100 ADDED");
		expect(t.row(8)).toContain("$800");

		await t.send("PF4");
		await t.fill("onhand", "10").send("ENTER");
		expect(t.message).toBe("CUS0407I PRODUCT GSK-100 UPDATED");
		expect(t.row(6)).toContain("LOW STOCK");

		await t.send("PF3");
		await t.fill("filter", "gsk").send("ENTER");
		expect(t.row(4)).toContain("ROW 1 TO 1 OF 1");
		await t.fill("sel:GSK-100", "u").send("ENTER");
		expect(t.scr.map).toBe("CUSP02");
		expect(t.row(1)).toContain("PRODUCT UPDATE");
	});
});

describe("invoice screens", () => {
	it("opens an invoice from the browse list, edits its lines, bills it and marks it paid", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "1").send("ENTER");
		await t.fill("sel:000110", "i").send("ENTER");
		expect(t.scr.map).toBe("CUSI01");
		expect(t.row(4)).toContain("JUNIPER SOFTWARE LABS");
		expect(t.row(9)).toContain("NO INVOICES FOR THIS CUSTOMER");

		await t.send("PF5");
		expect(t.scr.map).toBe("CUSI02");
		expect(t.message).toMatch(/^CUS0502I INVOICE INV\d{5} OPENED FOR 000110$/);
		const id = t.row(4).match(/INV\d{5}/)![0];
		expect(t.row(4)).toContain("OPEN");
		expect(t.scr.cursor).toEqual({ field: "sku" });

		await t.fill("sku", "vlv-0100", "qty", "2").send("ENTER");
		expect(t.message).toBe("CUS0511E ONLY 0 OF VLV-0100 ON HAND");
		expect(t.scr.cursor).toEqual({ field: "qty" });
		expect(t.field("sku")?.value).toBe("VLV-0100");

		await t.fill("sku", "chn-0080", "qty", "").send("ENTER");
		expect(t.message).toMatch(/^CUS0513I LINE 1 ADDED: 1 CHN-0080 AT \$/);
		await t.fill("sku", "blt-0516", "qty", "10", "po", "po 99").send("ENTER");
		expect(t.message).toMatch(/^CUS0513I LINE 2 ADDED: 10 BLT-0516/);
		expect(t.row(13)).toMatch(/2 BLT-0516/);
		expect(t.field("po")?.value).toBe("PO 99");

		await t.fill("qty:2", "20", "sel:1", "d").send("ENTER");
		expect(t.message).toBe(`CUS0514I INVOICE ${id} UPDATED`);
		expect(t.row(12)).toMatch(/2 BLT-0516 .* 20 /);
		expect(t.field("qty:1")).toBeUndefined();

		t.cursorField = "qty:2";
		await t.send("PF1");
		expect(t.row(1)).toContain("QUANTITY");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSI02");

		await t.send("PF10");
		expect(t.message).toBe("CUS0000W PF10 IS NOT ACTIVE ON THIS SCREEN");
		await t.send("PF6");
		expect(t.message).toMatch(new RegExp(`^CUS0515I INVOICE ${id} RELEASED TO THE WAREHOUSE ON SHP\\d{5}`));
		expect(t.field("sku")).toBeUndefined();
		expect(t.row(8)).toContain("PICKING - PF6 SHOWS IT");
		await t.send("PF10");
		expect(t.message).toBe(`CUS0510E INVOICE ${id} HAS NOT SHIPPED - ${t.row(8).match(/SHP\d{5}/)![0]} IS STILL IN THE WAREHOUSE`);
		await t.send("PF6");
		expect(t.scr.map).toBe("CUSS02");
		await t.fill("cartons", "2", "weight", "x").send("PF10");
		expect(t.message).toBe("CUS0811E WEIGHT MUST BE WHOLE POUNDS FROM 1 TO 99999");
		expect(t.scr.cursor).toEqual({ field: "weight" });
		await t.fill("weight", "35").send("PF10");
		expect(t.message).toMatch(/^CUS0807I SHP\d{5} PACKED: 2 CARTONS, 35 LB/);
		await t.fill("carrier", "dhl").send("PF10");
		expect(t.message).toBe("CUS0812E CARRIER MUST BE ONE OF UPS, FDX, TRK");
		await t.fill("carrier", "ups").send("PF10");
		expect(t.message).toMatch(/^CUS0808I SHP\d{5} SHIPPED VIA UPS 1Z\w+ - PF11 BILLS IT$/);
		await t.send("PF4");
		expect(t.scr.map).toBe("CUSI02");
		expect(t.row(8)).toMatch(/SHIPPED ON SHP\d{5} VIA UPS 1Z/);
		await t.send("PF10");
		expect(t.message).toMatch(new RegExp(`^CUS0507I INVOICE ${id} BILLED, \\$[\\d,]+ POSTED TO 000110$`));
		expect(t.row(4)).toContain("BILLED");
		expect(t.field("sku")).toBeUndefined();
		expect(t.field("qty:2")).toBeUndefined();
		await t.send("PF9");
		expect(t.message).toMatch(/^CUS0000W/);
		await t.send("PF11");
		expect(t.message).toMatch(/^CUS0508I/);
		expect(t.row(4)).toContain("PAID");

		await t.send("PF3");
		expect(t.scr.map).toBe("CUSI01");
		expect(t.row(9)).toMatch(new RegExp(`${id} 000110 +PO 99 +PAID`));
		expect(t.row(5)).toMatch(/BALANCE \$4,100 +LIMIT \$30,000 +AVAILABLE \$25,900 +UNPAID \$0/);
	});

	it("marks a billed invoice paid from the list", async () => {
		const inv = await createInvoice(env.DB, "IBMUSER", "000119", "");
		await addLine(env.DB, inv.id, "PLT-4848", 10);
		await shipInvoice(env.DB, inv.id);
		await billInvoice(env.DB, "IBMUSER", inv.id);
		const t = await Terminal.logon();
		await t.fill("option", "9 119").send("ENTER");
		expect(t.row(5)).toMatch(/BALANCE \$740 .* UNPAID \$140/);
		expect(t.row(9)).toMatch(/BILLED/);
		await t.fill(`sel:${inv.id}`, "p").send("ENTER");
		expect(t.message).toBe(`CUS0508I INVOICE ${inv.id} PAID, $140 PAYMENT POSTED - BALANCE NOW $600`);
		expect(t.row(9)).toMatch(/PAID/);
		await t.fill(`sel:${inv.id}`, "p").send("ENTER");
		expect(t.message).toMatch(/^CUS0519E INVOICE .* IS ALREADY PAID/);
	});

	it("cancels an open invoice with PF9 twice", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "9 116").send("ENTER");
		expect(t.scr.map).toBe("CUSI01");
		await t.send("PF5");
		const id = t.row(4).match(/INV\d{5}/)![0];
		await t.fill("sku", "saf-glv", "qty", "3").send("ENTER");
		await t.send("PF9");
		expect(t.message).toMatch(/^CUS0505W/);
		await t.send("PF9");
		expect(t.scr.map).toBe("CUSI01");
		expect(t.message).toBe(`CUS0506I INVOICE ${id} CANCELLED, STOCK RETURNED`);
	});

	it("finds a SKU to add with the product search", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "9 117").send("ENTER");
		await t.send("PF5");
		expect(t.scr.map).toBe("CUSI02");
		expect(t.row(t.scr.rows)).toContain("PF4=FIND SKU");

		await t.fill("sku", "bearing?", "qty", "4").send("ENTER");
		expect(t.scr.map).toBe("CUSI03");
		expect(t.field("q")?.value).toBe("BEARING");
		expect(t.row(9)).toMatch(/BRG-6204 +BALL BEARING 6204-2RS +\$9 +\d+/);
		expect(t.row(10)).toContain("BRG-6310");
		expect(t.scr.cursor).toEqual({ field: "sel:BRG-6204" });

		await t.fill("q", "glove").send("ENTER");
		expect(t.row(9)).toContain("SAF-GLV");
		await t.fill("q", "nothing like it").send("ENTER");
		expect(t.row(9)).toContain("NO ACTIVE PRODUCTS MATCH");
		await t.fill("q", "6310").send("ENTER");
		await t.fill("sel:BRG-6310", "x").send("ENTER");
		expect(t.message).toBe('CUS0103E INVALID SELECTION CODE "X"');
		await t.fill("sel:BRG-6310", "s").send("ENTER");
		expect(t.scr.map).toBe("CUSI02");
		expect(t.message).toBe("CUS0516I BRG-6310 SELECTED - ENTER A QUANTITY AND PRESS ENTER TO ADD IT");
		expect(t.field("sku")?.value).toBe("BRG-6310");
		expect(t.field("qty")?.value).toBe("4");
		expect(t.scr.cursor).toEqual({ field: "qty" });
		await t.send("ENTER");
		expect(t.message).toMatch(/^CUS0513I LINE 1 ADDED: 4 BRG-6310 AT \$31$/);

		// PF4 searches for what is in the SKU field; PF3 comes back unchanged.
		await t.fill("sku", "chn").send("PF4");
		expect(t.scr.map).toBe("CUSI03");
		expect(t.field("q")?.value).toBe("CHN");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSI02");
		expect(t.field("sku")?.value).toBe("CHN");

		// A SKU that is not on file but matches products opens the search.
		await t.fill("sku", "gloves").send("ENTER");
		expect(t.scr.map).toBe("CUSI03");
		expect(t.message).toBe("CUS0515I GLOVES IS NOT A SKU - 1 PRODUCT MATCH");
		await t.send("PF3");
		await t.fill("sku", "zzz-1").send("ENTER");
		expect(t.scr.map).toBe("CUSI02");
		expect(t.message).toBe("CUS0510E PRODUCT ZZZ-1 IS NOT ON FILE");
	});

	it("will not open an invoice for a customer on hold", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "9").send("ENTER");
		await t.send("PF5");
		expect(t.message).toMatch(/^CUS0501E/);
		await t.fill("cust", "103").send("ENTER");
		expect(t.row(4)).toContain("CONSOLIDATED FREIGHT");
		await t.send("PF5");
		expect(t.message).toBe("CUS0503E CUSTOMER IS ON HOLD - NO NEW INVOICES");
	});
});

describe("EDI screens", () => {
	it("lists the mailbox, shows an interchange's segments, and links to the invoice", async () => {
		const filed = await receive(env.DB, "TEST", partnerPO("000121", 77, "UB-9", [{ sku: "BLT-0750", qty: 2, price: 46 }]));
		const done = (await processInterchange(env.DB, filed.id))!;
		const inv = done.reference.split(" ")[2];
		const t = await Terminal.logon();
		await t.fill("option", "e 121").send("ENTER");
		expect(t.scr.map).toBe("CUSE01");
		expect(t.row(4)).toContain("ROW 1 TO 2 OF 2");
		expect(t.row(9)).toMatch(/OUT 997 +000121 +SENT/);
		expect(t.row(10)).toMatch(new RegExp(`${filed.id} IN  850 +000121 +ACCEPTED +PO UB-9 ${inv}`));

		await t.fill(`sel:${filed.id}`, "s").send("ENTER");
		expect(t.scr.map).toBe("CUSE02");
		expect(t.row(4)).toContain(`${filed.id}  850 PURCHASE ORDER`);
		expect(t.row(4)).toContain("ACCEPTED");
		expect(t.row(11)).toMatch(/^ +ISA\*00\*/);
		expect(t.row(14)).toContain("BEG*00*SA*UB-9");
		await t.send("PF4");
		expect(t.scr.map).toBe("CUSI02");
		expect(t.row(4)).toContain(inv);
		await t.send("PF3");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSE01");

		// The customer's event history has it too, and its detail shows the X12.
		await t.send("PF3");
		await t.fill("option", "5 121").send("ENTER");
		const n = [...Array(t.scr.rows).keys()].map((r) => t.row(r + 1)).find((l) => l.includes(`850 ACCEPTED`))!.trim().split(" ")[0];
		await t.fill("line", n).send("ENTER");
		expect(t.row(6)).toContain("EDI 850 PURCHASE ORDER RECEIVED");
		await t.send("PF6");
		expect(t.scr.map).toBe("CUSE02");
	});
});

describe("purchasing screens", () => {
	it("opens a PO for a vendor, sends it and receives it in two parts", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "p").send("ENTER");
		expect(t.scr.map).toBe("CUSV01");
		await t.send("PF5");
		expect(t.message).toBe("CUS0702E ENTER A VENDOR NUMBER FOR THE NEW PURCHASE ORDER");
		await t.fill("vendor", "4").send("ENTER");
		expect(t.field("vendor")?.value).toBe("V00004");
		expect(t.row(4)).toContain("RIVER CITY STEEL & PALLET");

		await t.send("PF5");
		expect(t.scr.map).toBe("CUSV02");
		expect(t.message).toMatch(/^CUS0703I PURCHASE ORDER PO\d{5} OPENED FOR V00004$/);
		const id = t.row(4).match(/PO\d{5}/)![0];
		await t.fill("sku", "brg-6204", "qty", "5").send("ENTER");
		expect(t.message).toBe("CUS0710E BRG-6204 IS SUPPLIED BY V00002, NOT V00004");
		await t.fill("sku", "stl-a36", "qty", "6").send("ENTER");
		expect(t.message).toBe("CUS0713I LINE 1 ADDED: 6 STL-A36 AT $246");
		expect(t.row(12)).toMatch(/1 STL-A36 +STEEL PLATE A36 1\/2 X 4 +6 +0 +\$246 +\$1,476/);

		await t.send("PF11");
		expect(t.message).toBe("CUS0000W PF11 IS NOT ACTIVE ON THIS SCREEN");
		await t.send("PF10");
		expect(t.message).toMatch(new RegExp(`^CUS0708I ${id} SENT TO V00004 AS 850 EDI\\d{5}, \\$1,476 AT COST$`));
		expect(t.row(4)).toContain("SENT");
		expect(t.scr.cursor).toEqual({ field: "rcv:1" });

		const before = (await env.DB.prepare("SELECT on_hand FROM products WHERE sku = 'STL-A36'").first<{ on_hand: number }>())!.on_hand;
		await t.fill("rcv:1", "9").send("ENTER");
		expect(t.message).toBe("CUS0712E LINE 1 HAS ONLY 6 STILL DUE");
		await t.fill("rcv:1", "2").send("ENTER");
		expect(t.message).toBe("CUS0717I 2 UNITS RECEIVED INTO STOCK - REST STILL DUE");
		expect(t.row(12)).toMatch(/ +6 +2 /);
		await t.send("PF11");
		expect(t.message).toBe(`CUS0714I ${id} RECEIVED IN FULL - 4 UNITS PUT IN STOCK`);
		expect(t.row(4)).toContain("RECEIVED");
		const after = (await env.DB.prepare("SELECT on_hand FROM products WHERE sku = 'STL-A36'").first<{ on_hand: number }>())!.on_hand;
		expect(after).toBe(before + 6);

		await t.send("PF3");
		expect(t.scr.map).toBe("CUSV01");
		expect(t.row(9)).toContain(`${id} V00004 RECEIVED`);
		await t.send("PF4");
		expect(t.scr.map).toBe("CUSV03");
		await t.fill("sel:V00001", "s").send("ENTER");
		expect(t.scr.map).toBe("CUSV01");
		expect(t.field("vendor")?.value).toBe("V00001");
	});

	it("shows the vendor, cost and stock on order on the product", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "8").send("ENTER");
		await t.fill("sel:HYD-0250", "u").send("ENTER");
		expect(t.field("vendor")?.value).toBe("V00003");
		expect(t.field("cost")?.value).toBe("83");
		await t.fill("vendor", "v12").send("ENTER");
		expect(t.message).toBe("CUS0416E VENDOR MUST BE A VENDOR NUMBER SUCH AS V00001");
		await t.fill("vendor", "v00001").send("ENTER");
		expect(t.message).toBe("CUS0407I PRODUCT HYD-0250 UPDATED");
		expect(t.row(11)).toContain("V00001");
		expect(t.row(9)).toMatch(/ON ORDER +0/);
	});
});

describe("batch job screens", () => {
	it("submits a job, lists it, and shows its output", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "7").send("ENTER");
		expect(t.scr.map).toBe("CUSJ01");
		expect(t.row(9)).toContain("NO JOBS ON THE SPOOL");

		await t.fill("job", "iefbr14").send("ENTER");
		expect(t.message).toBe("CUS0261E JOB IEFBR14 IS NOT IN THE JOB LIBRARY");
		expect(t.scr.cursor).toEqual({ field: "job" });

		const id = "JOB00001";
		const instance = await introspectWorkflowInstance(env.JOB_RUNNER, id);
		try {
			await t.fill("job", "cusstmt").send("ENTER");
			expect(t.message).toBe(`$HASP100 CUSSTMT ON INTRDR - ${id} SUBMITTED`);
			expect(t.row(9)).toMatch(new RegExp(`CUSSTMT +${id} +IBMUSER`));
			await instance.waitForStatus("complete");
		} finally {
			await instance.dispose();
		}

		await t.send("PF5");
		expect(t.row(9)).toMatch(/OUTPUT +0000/);
		await t.fill("sel0", "x").send("ENTER");
		expect(t.message).toMatch(/^CUS0103E/);
		await t.fill("sel0", "s").send("ENTER");
		expect(t.scr.map).toBe("CUSJ02");
		expect(t.row(3)).toContain(`CUSSTMT  ${id}  OUTPUT  RC=0000`);
		expect(t.row(4)).toContain("J E S 2   J O B   L O G");
		await t.send("PF8");
		expect(t.row(3)).toMatch(/LINE +19 OF/);
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSJ01");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM00");
	});
});

describe("operator console", () => {
	const lines = (t: Terminal) => [...Array(t.scr.rows).keys()].map((r) => t.row(r + 1).trimEnd());

	it("follows SYSLOG and logs commands with their responses", async () => {
		const log = (source: string, text: string) =>
			env.DB.prepare("INSERT INTO syslog (at, source, text) VALUES (?, ?, ?)").bind(new Date().toISOString(), source, text).run();
		for (let i = 0; i < 20; i++) await log("X", `EARLIER ${i}`);
		const t = await Terminal.logon();
		await t.fill("option", "o").send("ENTER");
		expect(t.scr.map).toBe("CUSO01");
		expect((t.scr as { refresh?: number }).refresh).toBe(5);
		expect(t.row(4)).toContain("SYSLOG - FOLLOWING");
		expect(lines(t).some((l) => /IBMUSER +IKJ56455I IBMUSER LOGON IN PROGRESS ON TERM0001/.test(l))).toBe(true);

		await t.fill("cmd", "d t").send("ENTER");
		const tail = lines(t).slice(4, 22).filter((l) => l.trim());
		expect(tail.at(-2)).toMatch(/IBMUSER +D T$/);
		expect(tail.at(-1)).toMatch(/IBMUSER +IEE136I LOCAL: TIME=\d\d\.\d\d\.\d\d DATE=\d{4}\.\d{3}  UTC:/);

		await t.fill("cmd", "d sched").send("ENTER");
		expect(lines(t).some((l) => /CUSCRREV 0 6 \* \* \* +ACTIVE  NEXT/.test(l))).toBe(true);
		expect(lines(t).some((l) => /EDISIM +0 \* \* \* \* +HELD/.test(l))).toBe(true);

		await t.fill("cmd", "s iefbr14").send("ENTER");
		expect(t.message).toBe("CUS0705E JOB IEFBR14 IS NOT IN THE JOB LIBRARY");
		expect(t.field("cmd")!.value).toBe("S IEFBR14");
		await t.fill("cmd", "frobnicate").send("ENTER");
		expect(lines(t).some((l) => l.includes("IEE305I FROBNICATE COMMAND INVALID"))).toBe(true);

		// A redraw shows lines written since, as the terminal's refresh does.
		await log("JOB00042", "$HASP373 CUSAGING STARTED");
		await t.send("REDRAW");
		expect(t.row(22)).toMatch(/JOB00042 +\$HASP373 CUSAGING STARTED/);

		// Scrolled back, it holds still and stops refreshing.
		for (let i = 0; i < 20; i++) await log("X", `LINE ${i}`);
		await t.send("REDRAW");
		expect(t.row(22)).toContain("LINE 19");
		await t.send("PF7");
		expect(t.row(22)).toContain("LINE 1 ");
		expect(t.row(4)).toContain("SYSLOG - HELD");
		expect((t.scr as { refresh?: number }).refresh).toBeUndefined();
		await t.send("PF8");
		expect(t.row(4)).toContain("SYSLOG - FOLLOWING");
		expect(t.row(22)).toContain("LINE 19");
		await t.send("PF8");
		expect(t.message).toBe("CUS0102W ALREADY AT BOTTOM OF DATA");

		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM00");
	});

	it("changes the job schedule", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "o").send("ENTER");
		await t.send("PF6");
		expect(t.scr.map).toBe("CUSO02");
		expect(t.row(9)).toMatch(/CUSAGING 15 6 \* \* \* +ACTIVE \d{4}-\d\d-\d\d \d\d:15/);
		expect(t.row(12)).toMatch(/EDISIM +0 \* \* \* \* +HELD/);

		await t.fill("job", "cusstmt", "cron", "0 7 31 2 *").send("ENTER");
		expect(t.message).toBe("CUS0702I SCHEDULE CUSSTMT SET TO 0 7 31 2 *");
		await t.fill("job", "cusstmt", "cron", "0 7 32 * *").send("ENTER");
		expect(t.message).toBe("CUS0709E CRON DAY 32 IS NOT 1-31");
		expect(t.scr.cursor).toEqual({ field: "cron" });
		expect(t.field("cron")!.value).toBe("0 7 32 * *");
		await t.fill("job", "nosuch", "cron", "@daily").send("ENTER");
		expect(t.scr.cursor).toEqual({ field: "job" });

		await t.fill("sel3", "r").send("ENTER"); // EDISIM
		expect(t.message).toBe("CUS0703I SCHEDULE EDISIM RELEASED");
		expect(t.row(12)).toMatch(/EDISIM +0 \* \* \* \* +ACTIVE/);
		await t.fill("sel3", "h").send("ENTER");
		expect(t.row(12)).toMatch(/EDISIM +0 \* \* \* \* +HELD/);
		await t.fill("sel2", "d").send("ENTER");
		expect(t.message).toBe("CUS0704I SCHEDULE CUSSTMT DELETED");
		await t.fill("sel0", "x").send("ENTER");
		expect(t.message).toMatch(/^CUS0103E/);

		// Field help explains the cron.
		t.cursorField = "cron";
		await t.send("PF1");
		expect(t.row(1)).toContain("HELP - CRON EXPRESSION (UTC)");
		await t.send("PF3");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSO01");
		expect([...Array(t.scr.rows).keys()].some((r) => t.row(r + 1).includes("CUS0704I SCHEDULE CUSSTMT DELETED"))).toBe(true);
	});
});

describe("held output", () => {
	it("prints a report to the spool, browses, prints and purges it", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "4").send("ENTER");
		await t.send("PF9");
		const id = t.message.match(/^CUS0302I REPORT PRINTED TO THE SPOOL AS (TSU\d{5}) - SEE OPTION H$/)![1];

		await t.send("PF3");
		await t.fill("option", "h cusr").send("ENTER");
		expect(t.scr.map).toBe("CUSQ01");
		expect(t.field("filter")!.value).toBe("CUSR");
		expect(t.row(9)).toMatch(new RegExp(`CUSR01 +${id} IBMUSER  HELD +\\d+ +0 .*CREDIT EXPOS`));

		await t.fill("sel0", "s").send("ENTER");
		expect(t.scr.map).toBe("CUSQ02");
		expect(t.row(3)).toContain(`CUSR01  ${id}  HELD  CREDIT EXPOSURE SUMMARY`);
		expect(t.row(4)).toMatch(/^  CUSR01 +CREDIT EXPOSURE SUMMARY/);
		await t.send("PF4");
		expect(t.message).toMatch(new RegExp(`^\\$HASP150 CUSR01 ${id} ON PRT1 - \\d+ LINES, COPY 1$`));
		await t.send("PF3");
		expect(t.row(9)).toMatch(/PRINTED +\d+ +1 /);

		await t.fill("sel0", "o").send("ENTER");
		expect(t.message).toMatch(/COPY 2$/);
		await t.fill("sel0", "z").send("ENTER");
		expect(t.message).toMatch(/^CUS0103E/);
		await t.fill("sel0", "p").send("ENTER");
		expect(t.message).toBe(`$HASP250 ${id} PURGED`);
		expect(t.row(9)).toContain("NO OUTPUT FOR JOBS STARTING CUSR");
		await t.fill("filter", "").send("ENTER");
		expect(t.field("filter")!.value ?? "").toBe("");
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSM00");
	});
});

describe("ledger screens", () => {
	it("shows the trial balance, an account's entries, and guards the close", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "a").send("ENTER");
		expect(t.scr.map).toBe("CUSA01");
		expect(t.row(4)).toMatch(/OPEN/);
		expect(t.row(9)).toMatch(/1000 CASH +ASSET/);
		await t.send("PF10");
		expect(t.message).toMatch(/^\$HASP100 CUSTRIAL ON INTRDR - JOB\d{5} SUBMITTED/);
		await journal(env.DB, "TEST");
		await t.send("ENTER");
		expect(t.row(19)).toBe("   DEBITS EQUAL CREDITS - THE LEDGER IS IN BALANCE".padEnd(80));
		expect(t.row(20)).toMatch(/AR CONTROL \$[\d,]+ +CUSTOMER ACCOUNTS \$[\d,]+ +AGREE/);

		await t.send("PF5");
		expect(t.message).toBe("CUS0903W PRESS PF5 AGAIN TO RUN THE MONTH-END CLOSE AND CLOSE THE PERIOD");
		await t.send("ENTER");
		await t.fill("period", "2026-1").send("ENTER");
		expect(t.message).toBe("CUS0902E PERIOD MUST BE YYYY-MM, SUCH AS 2026-10");
		await t.fill("period", "1999-01").send("ENTER");
		expect(t.message).toBe("CUS0901E PERIOD 1999-01 NOT FOUND");
		await t.fill("period", "").send("ENTER");

		await t.fill("sel:1200", "s").send("ENTER");
		expect(t.scr.map).toBe("CUSA02");
		expect(t.row(4)).toContain("1200 ACCOUNTS RECEIVABLE");
		const rows = [...Array(t.scr.rows).keys()].map((r) => t.row(r + 1));
		expect(rows.some((r) => /OPEN:AR +OPENING CUSTOMER/.test(r))).toBe(true);
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSA01");
	});
});

describe("screen size", () => {
	it("lays panels out for a larger window and redraws without acting", async () => {
		const t = await Terminal.logon(40, 132);
		expect(t.scr.rows).toBe(40);
		expect(t.row(40)).toContain("PF3=LOGOFF");
		expect(t.row(1).trimEnd()).toMatch(/\d\d\/\d\d\/\d\d$/);
		expect(t.row(1).trimEnd().length).toBe(77 + 52);

		await t.send("PF4");
		expect(t.row(4)).toMatch(/ROW 1 TO \d+ OF/);
		const state = t.state;

		// A redraw keeps the commarea and the input is not acted on.
		t.rows = 24;
		t.cols = 80;
		await t.fill("filter", "zzz").send("REDRAW");
		expect(t.state).toBe(state);
		expect(t.row(4)).toContain("ROW 1 TO 13 OF");
	});

	it("never goes below 24x80", async () => {
		const t = await Terminal.logon(10, 10);
		expect([t.scr.rows, t.scr.cols]).toEqual([24, 80]);
	});
});
