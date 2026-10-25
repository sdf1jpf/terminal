// Field help: PF1 with the cursor in an input field explains that field,
// as CICS and ISPF applications do. Help is looked up by panel and field
// name first ("browse.status"), then by field name alone. Selection fields
// ("sel:000101", "sel0") share the "sel" entry for their panel, and invoice
// line quantities ("qty:3") share the "qty" entry.

import type { State } from "./program";

export interface FieldHelp {
	title: string;
	lines: string[];
}

const help: Record<string, FieldHelp> = {
	"menu.option": {
		title: "OPTION",
		lines: [
			"Type an option number or name from the list and press Enter.",
			"",
			"Options 2, 5 and 6 take a customer number, so 2 105 or 5 000105 jumps",
			"straight to that customer. Option 1 takes the start of a name, so",
			"1 KEY browses the customers whose name begins with KEY.",
		],
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
	},
	"browse.status": {
		title: "STATUS",
		lines: [
			"Lists only the customers with this status:",
			"  A  active",
			"  H  on hold: payments are taken, new invoices are refused",
			"  C  closed",
		],
	},
	"browse.sel": {
		title: "SELECTION CODE",
		lines: [
			"Type a code beside a customer and press Enter:",
			"  S  show the customer          U  update it",
			"  D  delete it                  A  account activity",
			"  H  change history             I  invoices",
		],
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
		lines: [
			"  A  active",
			"  H  on hold: payments are taken, new invoices are refused",
			"  C  closed: payments are taken, new invoices are refused",
		],
	},
	type: {
		title: "TYPE",
		lines: [
			"  I  invoice: adds the amount to the balance",
			"  P  payment: takes the amount off the balance",
			"",
			"Invoices can only be posted to active customers.",
		],
	},
	amount: {
		title: "AMOUNT",
		lines: ["The amount in whole dollars, more than zero."],
	},
	ref: {
		title: "REFERENCE",
		lines: ["Your reference for the posting, such as an invoice or check number.", "Up to 12 characters. Optional."],
	},
	job: {
		title: "SUBMIT JOB",
		lines: [
			"The name of a job to run in the background:",
			"  CUSAGING  aged balances report",
			"  CUSCRREV  credit review: lists accounts near their limit and puts",
			"            active accounts over their limit on hold",
			"  CUSSTMT   statements for open accounts with a balance",
			"",
			"Press PF5 to refresh the list as the job runs.",
		],
	},
	"products.filter": {
		title: "SKU STARTS WITH",
		lines: ["Lists only the products whose SKU begins with these characters."],
	},
	"products.sel": {
		title: "SELECTION CODE",
		lines: ["Type a code beside a product and press Enter:", "  S  show the product           U  update it"],
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
		lines: ["  A  active", "  D  discontinued: kept on file, but cannot be sold"],
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
		lines: ["Type S beside an invoice and press Enter to show it."],
	},
	"invoice.sku": {
		title: "ADD LINE: SKU",
		lines: [
			"The SKU of a product to add to the invoice, such as BRG-6204. The line",
			"is priced at the product's unit price and its quantity comes out of",
			"stock. Discontinued products cannot be sold.",
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
	},
	po: {
		title: "PO NUMBER",
		lines: ["The customer's purchase order number, up to 22 characters. Optional."],
	},
	"jobs.sel": {
		title: "SELECTION CODE",
		lines: ["Type S beside a job and press Enter to view its output."],
	},
};

// fieldHelp returns the help for the field the cursor was in, if any.
export function fieldHelp(s: State, field: string): FieldHelp | undefined {
	if (!field) return undefined;
	const name = field.startsWith("sel") ? "sel" : field.split(":")[0];
	return help[`${s.p}.${name}`] ?? help[name];
}
