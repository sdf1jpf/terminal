// Field help: PF1 with the cursor in an input field explains that field,
// as CICS and ISPF applications do. Help is looked up by panel and field
// name first ("browse.status"), then by field name alone. Selection fields
// ("sel:000101", "sel0") share the "sel" entry for their panel, and invoice
// line quantities ("qty:3") share the "qty" entry.
//
// A field with a fixed set of valid values lists them under the help, as
// ISPF prompts do: S beside one puts it in the field.

import { jobLibrary } from "../jobs";
import { listVendors } from "../purchasing";
import { carriers } from "../shipping";
import { hitTypes } from "../search";
import { menuValues } from "./menu";
import type { Ctx } from "./screen";
import type { State } from "./program";

export interface Value {
	code: string;
	desc: string;
}

export interface FieldHelp {
	title: string;
	lines: string[];
	values?: Value[] | ((ctx: Ctx, s: State) => Promise<Value[]>);
}

const v = (...pairs: [string, string][]): Value[] => pairs.map(([code, desc]) => ({ code, desc }));

const customerStatus = v(
	["A", "ACTIVE"],
	["H", "ON HOLD: PAYMENTS ARE TAKEN, NEW INVOICES ARE REFUSED"],
	["C", "CLOSED: PAYMENTS ARE TAKEN, NEW INVOICES ARE REFUSED"],
);

const states = v(
	["AL", "ALABAMA"], ["AK", "ALASKA"], ["AZ", "ARIZONA"], ["AR", "ARKANSAS"], ["CA", "CALIFORNIA"],
	["CO", "COLORADO"], ["CT", "CONNECTICUT"], ["DE", "DELAWARE"], ["DC", "DISTRICT OF COLUMBIA"],
	["FL", "FLORIDA"], ["GA", "GEORGIA"], ["HI", "HAWAII"], ["ID", "IDAHO"], ["IL", "ILLINOIS"],
	["IN", "INDIANA"], ["IA", "IOWA"], ["KS", "KANSAS"], ["KY", "KENTUCKY"], ["LA", "LOUISIANA"],
	["ME", "MAINE"], ["MD", "MARYLAND"], ["MA", "MASSACHUSETTS"], ["MI", "MICHIGAN"], ["MN", "MINNESOTA"],
	["MS", "MISSISSIPPI"], ["MO", "MISSOURI"], ["MT", "MONTANA"], ["NE", "NEBRASKA"], ["NV", "NEVADA"],
	["NH", "NEW HAMPSHIRE"], ["NJ", "NEW JERSEY"], ["NM", "NEW MEXICO"], ["NY", "NEW YORK"],
	["NC", "NORTH CAROLINA"], ["ND", "NORTH DAKOTA"], ["OH", "OHIO"], ["OK", "OKLAHOMA"], ["OR", "OREGON"],
	["PA", "PENNSYLVANIA"], ["RI", "RHODE ISLAND"], ["SC", "SOUTH CAROLINA"], ["SD", "SOUTH DAKOTA"],
	["TN", "TENNESSEE"], ["TX", "TEXAS"], ["UT", "UTAH"], ["VT", "VERMONT"], ["VA", "VIRGINIA"],
	["WA", "WASHINGTON"], ["WV", "WEST VIRGINIA"], ["WI", "WISCONSIN"], ["WY", "WYOMING"],
);

const jobs = async (): Promise<Value[]> =>
	Object.entries(jobLibrary).map(([code, j]) => ({ code, desc: j.title }));

const vendors = async (ctx: Ctx): Promise<Value[]> =>
	(await listVendors(ctx.db)).map((x) => ({ code: x.id, desc: `${x.name}, ${x.city} ${x.state}${x.status === "A" ? "" : " (INACTIVE)"}` }));

const show = v(["S", "SHOW IT"]);

const help: Record<string, FieldHelp> = {
	"menu.option": {
		title: "OPTION",
		lines: [
			"Type an option from the list and press Enter. On the primary menu the",
			"numbers open a submenu for each module; PF3 comes back.",
			"",
			"A fast path such as 1.2 or =1.2 goes straight to an option from any",
			"menu, and a name such as INQUIRY, EDI or SYSLOG works anywhere too.",
			"A second word is passed to the option: 1.2 105 shows customer 000105,",
			"1.1 KEY browses the names that begin with KEY. =X logs off. FIND ACME",
			"searches everything for ACME. PF24 (RETRIEVE) brings back the last",
			"commands entered, newest first.",
		],
		values: async (_ctx, s) => menuValues(s),
	},
	"browse.filter": {
		title: "NAME STARTS WITH",
		lines: [
			"Lists only the customers whose name begins with these letters.",
			"Leave it blank to list everyone. Press Enter to apply it.",
		],
	},
	"browse.city": {
		title: "CITY",
		lines: ["Lists only the customers whose city begins with these letters."],
	},
	"browse.state": {
		title: "STATE",
		lines: ["Lists only the customers in this state: a two letter code, such as OH."],
		values: states,
	},
	"browse.status": {
		title: "STATUS",
		lines: ["Lists only the customers with this status. Leave it blank to list them all."],
		values: customerStatus,
	},
	"browse.sel": {
		title: "SELECTION CODE",
		lines: ["Type a code beside a customer and press Enter."],
		values: v(
			["S", "SHOW THE CUSTOMER"], ["U", "UPDATE IT"], ["D", "DELETE IT"],
			["A", "EVENT HISTORY"], ["H", "CHANGE HISTORY"], ["I", "INVOICES"],
		),
	},
	id: {
		title: "CUSTOMER NUMBER",
		lines: [
			"The six digit number the system gave the customer when it was added.",
			"Leading zeros may be left off: 105 is the same as 000105.",
		],
	},
	name: {
		title: "NAME",
		lines: ["The customer's name, up to 30 characters. Required."],
	},
	addr: {
		title: "ADDRESS",
		lines: ["The street address, up to 30 characters. Optional."],
	},
	city: {
		title: "CITY",
		lines: ["The city, up to 18 characters. Required."],
	},
	state: {
		title: "STATE",
		lines: ["The two letter state code, such as OH. Required."],
		values: states,
	},
	zip: {
		title: "ZIP CODE",
		lines: ["The five digit ZIP code. Required."],
	},
	phone: {
		title: "PHONE",
		lines: ["The phone number as NNN-NNN-NNNN, such as 937-555-0101. Optional."],
	},
	limit: {
		title: "CREDIT LIMIT",
		lines: [
			"The most the customer may owe, in whole dollars, up to 999,999,999.",
			"The credit review job (CUSCRREV) puts active accounts over their",
			"limit on hold.",
		],
	},
	status: {
		title: "STATUS",
		lines: ["Whether the customer may be sold to."],
		values: customerStatus,
	},
	"activity.line": {
		title: "SHOW LINE",
		lines: [
			"Type the number of an event in the list and press Enter to see its",
			"details: what changed, or the invoice and its lines. PF4 there shows",
			"the invoice itself.",
		],
	},
	"edi.partner": {
		title: "PARTNER",
		lines: [
			"Lists only the interchanges with this customer's or vendor's system.",
			"Any customer can trade by EDI: its interchange ID is its customer",
			"number. Vendors trade under their vendor number, such as V00001.",
		],
	},
	"edi.sel": {
		title: "SELECTION CODE",
		lines: ["Type S beside an interchange and press Enter to see its X12 segments."],
		values: v(["S", "SHOW THE X12 SEGMENTS"]),
	},
	job: {
		title: "SUBMIT JOB",
		lines: [
			"The name of a job from the job library to run in the background. Press",
			"PF5 to refresh the list as the job runs.",
		],
		values: jobs,
	},
	"products.filter": {
		title: "SKU STARTS WITH",
		lines: ["Lists only the products whose SKU begins with these characters."],
	},
	"products.sel": {
		title: "SELECTION CODE",
		lines: ["Type a code beside a product and press Enter."],
		values: v(["S", "SHOW THE PRODUCT"], ["U", "UPDATE IT"]),
	},
	sku: {
		title: "SKU",
		lines: [
			"The stock keeping unit: the product's code, 1 to 10 letters, digits or",
			"dashes, such as BRG-6204. It cannot be changed once the product is added.",
		],
	},
	desc: {
		title: "DESCRIPTION",
		lines: ["What the product is, up to 30 characters. Required."],
	},
	price: {
		title: "UNIT PRICE",
		lines: ["The price of one unit in whole dollars. Invoice lines are priced from it."],
	},
	onhand: {
		title: "QUANTITY ON HAND",
		lines: [
			"How many units are in stock. Invoice lines take stock as they are added",
			"and give it back when they are removed. Type a new count to receive",
			"stock or correct a stock take.",
		],
	},
	reorder: {
		title: "REORDER POINT",
		lines: ["When the quantity on hand falls to this number or below, the product", "is flagged LOW and shown in yellow."],
	},
	"product.status": {
		title: "STATUS",
		lines: ["Whether the product may be sold."],
		values: v(["A", "ACTIVE"], ["D", "DISCONTINUED: KEPT ON FILE, BUT CANNOT BE SOLD"]),
	},
	"invoices.cust": {
		title: "CUSTOMER NUMBER",
		lines: [
			"Lists only this customer's invoices. Leave it blank to list them all.",
			"PF5 opens a new invoice for the customer in this field.",
		],
	},
	"invoices.sel": {
		title: "SELECTION CODE",
		lines: ["Type a code beside an invoice and press Enter."],
		values: v(["S", "SHOW THE INVOICE"], ["P", "MARK A BILLED INVOICE PAID: POSTS A PAYMENT FOR ITS TOTAL"]),
	},
	"invoice.sku": {
		title: "ADD LINE: SKU",
		lines: [
			"The SKU of a product to add to the invoice, such as BRG-6204. The line",
			"is priced at the product's unit price and its quantity comes out of",
			"stock. Discontinued products cannot be sold.",
			"",
			"Not sure of the SKU? Press PF4, or type part of a SKU or description",
			"with a ? (such as GLOVE?) and press Enter, to search the product file.",
		],
	},
	"invoice.qty": {
		title: "QUANTITY",
		lines: [
			"How many units, from 1 to 99999. On the add line it may be left blank",
			"for one unit. Overtype a line's quantity to change it: stock moves by",
			"the difference. Use D in the selection column to remove a line.",
		],
	},
	"invoice.sel": {
		title: "SELECTION CODE",
		lines: ["Type D beside a line and press Enter to remove it and return its stock."],
		values: v(["D", "REMOVE THE LINE"]),
	},
	"skusearch.q": {
		title: "SKU OR DESCRIPTION",
		lines: [
			"Lists the active products whose SKU or description contains these",
			"letters, such as BRG or GLOVE. Leave it blank to list them all.",
			"Press Enter to search.",
		],
	},
	"skusearch.sel": {
		title: "SELECTION CODE",
		lines: [
			"Type S beside a product and press Enter to take its SKU back to the",
			"invoice's add line, then enter a quantity and press Enter to add it.",
		],
		values: v(["S", "ADD TO THE INVOICE"]),
	},
	po: {
		title: "PO NUMBER",
		lines: ["The customer's purchase order number, up to 22 characters. Optional."],
	},
	vendor: {
		title: "VENDOR",
		lines: [
			"The vendor that supplies the product, by vendor number, such as V00001.",
			"Purchase orders for the product go to this vendor. Leave it blank if",
			"the product is not bought in: the reorder job (CUSREORD) then skips it.",
		],
		values: vendors,
	},
	cost: {
		title: "UNIT COST",
		lines: ["What one unit costs us from the vendor, in whole dollars. Purchase", "order lines are costed from it."],
	},
	"pos.vendor": {
		title: "VENDOR",
		lines: [
			"Lists only this vendor's purchase orders: a vendor number such as",
			"V00001 (V1 will do). PF5 opens a new purchase order for the vendor in",
			"this field, and PF4 lists the vendors.",
		],
		values: vendors,
	},
	"pos.sel": {
		title: "SELECTION CODE",
		lines: ["Type a code beside a purchase order and press Enter."],
		values: v(["S", "SHOW THE PURCHASE ORDER"], ["R", "RECEIVE EVERYTHING STILL DUE ON A SENT ORDER INTO STOCK"]),
	},
	"po.sku": {
		title: "ADD LINE: SKU",
		lines: [
			"The SKU of a product this vendor supplies. The line is costed at the",
			"product's unit cost. Stock goes up only when the goods are received.",
		],
	},
	"po.qty": {
		title: "QUANTITY",
		lines: ["How many units to order, from 1 to 99999. Blank orders one."],
	},
	"po.sel": {
		title: "SELECTION CODE",
		lines: ["Type D beside a line and press Enter to remove it from the order."],
		values: v(["D", "REMOVE THE LINE"]),
	},
	"po.rcv": {
		title: "QUANTITY RECEIVED",
		lines: [
			"How many units of the line came in, up to the quantity still due.",
			"Press Enter to put them in stock. PF11 receives everything still due.",
			"The order is RECEIVED once every line is in.",
		],
	},
	"shipments.status": {
		title: "STATUS",
		lines: ["Lists only the shipments in this status. Leave it blank to list them all."],
		values: v(
			["P", "PICKING: RELEASED TO THE WAREHOUSE, PICK TICKET PRINTED"],
			["K", "PACKED: CARTONS AND WEIGHT RECORDED"],
			["S", "SHIPPED: GONE WITH A CARRIER"],
		),
	},
	"shipments.sel": {
		title: "SELECTION CODE",
		lines: ["Type S beside a shipment and press Enter to see its pick ticket."],
		values: v(["S", "SHOW THE PICK TICKET"]),
	},
	cartons: {
		title: "CARTONS",
		lines: ["How many cartons the order was packed in, 1 to 999. PF10 records it."],
	},
	weight: {
		title: "WEIGHT",
		lines: ["The shipment's total weight in whole pounds, 1 to 99999."],
	},
	carrier: {
		title: "CARRIER",
		lines: [
			"Who takes the shipment. PF10 ships it, gives it a tracking number and,",
			"if the customer ordered by EDI, sends its system an 856 ship notice.",
			"The invoice can be billed once it has shipped: PF11 here, or PF10 on",
			"the invoice.",
		],
		values: async () => Object.entries(carriers).map(([code, desc]) => ({ code, desc })),
	},
	"ledger.period": {
		title: "PERIOD",
		lines: [
			"The accounting period to show, as YYYY-MM. Blank shows the open one.",
			"Balances are as of the end of the period; IN PERIOD is its own",
			"activity. Entries go to the open period when they are journaled:",
			"PF10 journals the latest activity (CUSTRIAL) and PF5 twice runs the",
			"month-end close (CUSCLOSE), which journals, prints the trial balance,",
			"closes the period and opens the next.",
		],
	},
	"ledger.sel": {
		title: "SELECTION CODE",
		lines: ["Type S beside an account and press Enter to list its entries in the period."],
		values: v(["S", "LIST THE ENTRIES"]),
	},
	"vendors.sel": {
		title: "SELECTION CODE",
		lines: ["Type S beside a vendor and press Enter to list its purchase orders."],
		values: v(["S", "LIST ITS PURCHASE ORDERS"]),
	},
	"console.cmd": {
		title: "OPERATOR COMMAND",
		lines: [
			"An operator command. It goes in the log with its response, for every",
			"console to see. S jobname submits a job, such as S CUSAGING, H jobname",
			"holds its schedule and A jobname releases it. PF24 (RETRIEVE) brings",
			"back the last commands entered.",
		],
		values: v(
			["D T", "DISPLAY THE TIME, LOCAL AND UTC"],
			["D J", "DISPLAY THE JOBS THAT ARE QUEUED OR EXECUTING"],
			["D SCHED", "DISPLAY THE JOB SCHEDULE"],
			["SCHED", "OPEN THE JOB SCHEDULE (PF6)"],
		),
	},
	"schedule.job": {
		title: "JOB NAME",
		lines: [
			"A job from the job library to schedule. With a cron, Enter adds it to the",
			"schedule, or changes its cron if it is already there.",
		],
		values: jobs,
	},
	"schedule.cron": {
		title: "CRON EXPRESSION (UTC)",
		lines: [
			"When the scheduler submits the job: five fields, in UTC.",
			"",
			"  MINUTE 0-59  HOUR 0-23  DAY 1-31  MONTH 1-12  WEEKDAY 0-7 (0 AND 7 ARE SUN)",
			"",
			"Each takes *, a number, a range (1-5), a step (*/15) or a list (1,15).",
			"  0 6 * * *      06:00 UTC every day",
			"  */15 * * * *   every 15 minutes",
			"  0 7 1 * *      07:00 UTC on the first of the month",
			"  0 6 * * MON-FRI   weekdays",
			"@HOURLY, @DAILY, @WEEKLY and @MONTHLY are shorthands.",
		],
	},
	"schedule.sel": {
		title: "SELECTION CODE",
		lines: ["Type a code beside a scheduled job and press Enter."],
		values: v(
			["H", "HOLD THE SCHEDULE: THE SCHEDULER SKIPS IT"],
			["R", "RELEASE IT AGAIN"],
			["S", "SUBMIT THE JOB NOW, WITHOUT CHANGING THE SCHEDULE"],
			["D", "DELETE THE SCHEDULE"],
		),
	},
	"spool.filter": {
		title: "JOBNAME STARTS WITH",
		lines: ["Show only output whose job name starts with this, such as CUS. Blank for all."],
	},
	"spool.sel": {
		title: "SELECTION CODE",
		lines: ["Type a code beside an output group and press Enter."],
		values: v(
			["S", "BROWSE THE OUTPUT"],
			["O", "PRINT IT ON PRT1; IT STAYS ON THE SPOOL FOR ANOTHER COPY"],
			["D", "SEND IT TO YOUR TERMINAL AS A PDF, ON GREEN-BAR PAPER"],
			["P", "PURGE IT, AND THE JOB'S ENTRY WITH IT"],
		),
	},
	"archive.filter": {
		title: "NAME OR REF",
		lines: [
			"Show only entries whose job name or reference starts with this: a job",
			"name such as CUSSTMT, an output ID such as JOB00012, a customer number",
			"for statements and letters, or a period such as 2026-10. Blank for all.",
		],
	},
	"archive.kind": {
		title: "KIND",
		lines: ["Show only one kind of entry. Leave it blank for all of them."],
		values: v(
			["L", "LISTING: OUTPUT MOVED OFF THE SPOOL BY CUSARCH AFTER A WEEK"],
			["M", "MONTH-END: TRIAL BALANCE AND AGING FILED BY CUSCLOSE"],
			["S", "STATEMENT: FILED BY CUSSTMT, ONE PER CUSTOMER PER MONTH"],
			["D", "DUNNING LETTER: FILED BY CUSDUNN"],
		),
	},
	"archive.sel": {
		title: "SELECTION CODE",
		lines: ["Type a code beside an entry and press Enter."],
		values: v(
			["S", "BROWSE IT"],
			["D", "SEND ITS PDF TO YOUR TERMINAL"],
			["R", "RESTORE A LISTING TO THE SPOOL, HELD, UNDER ITS ORIGINAL ID"],
		),
	},
	"jobs.sel": {
		title: "SELECTION CODE",
		lines: ["Type S beside a job and press Enter to view its output."],
		values: v(["S", "VIEW THE OUTPUT"]),
	},
	"search.q": {
		title: "SEARCH FOR",
		lines: [
			"A name or number to look for. Customers are found by number, name,",
			"city or phone; invoices by number, the customer's PO number, or the",
			"customer's number or name; purchase orders by number or vendor;",
			"shipments by number, invoice or tracking number; vendors by number,",
			"name or city; products by SKU, description or vendor.",
			"",
			"Any part will do: GEAR finds BLUE GEAR CO, and 105 finds customer",
			"000105 with its invoices and shipments. FIND ACME on any command",
			"line searches straight away.",
		],
	},
	"search.type": {
		title: "TYPE",
		lines: ["Lists only this type of record. Leave it blank to search them all."],
		values: async () => Object.entries(hitTypes).map(([code, desc]) => ({ code, desc })),
	},
	"search.sel": {
		title: "SELECTION CODE",
		lines: ["Type S beside a record and press Enter to show it. PF3 there comes back here."],
		values: show,
	},
};

// fieldValues returns the valid values for a field, or none.
export async function fieldValues(ctx: Ctx, fh: FieldHelp, s: State): Promise<Value[]> {
	if (!fh.values) return [];
	return Array.isArray(fh.values) ? fh.values : fh.values(ctx, s);
}

// fieldHelp returns the help for the field the cursor was in, if any.
export function fieldHelp(s: State, field: string): FieldHelp | undefined {
	if (!field) return undefined;
	const name = field.startsWith("sel") ? "sel" : field.split(":")[0];
	return help[`${s.p}.${name}`] ?? help[name];
}
