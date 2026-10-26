// The HELP facility's knowledge base: what the system knows about itself,
// as short topics. Most are built from the code (every menu option, every
// field's help, the PF keys, the job library) so they cannot drift from
// what the screens do; a few describe how the business works. ai.ts
// indexes them in Vectorize and hands the best ones to the model.

import { tutorialKeys } from "@greenscreen-dev/worker";
import { jobLibrary } from "./jobs";
import { fieldTopics } from "./screens/fieldhelp";
import { menuTopics } from "./screens/menu";

export interface Topic {
	id: string; // e.g. "menu:1.2", "field:browse.status", "job:CUSAGING"
	title: string;
	text: string;
	go?: string; // a command that opens the screen it is about, such as =1.2
}

// The fast path to the panel each field help entry belongs to, so a topic
// about a field can take the operator there.
const panelPaths: Record<string, string> = {
	menu: "=", browse: "=1.1", detail: "=1.2", activity: "=1.4", search: "=1.5",
	invoices: "=2.1", invoice: "=2.1", skusearch: "=2.1", shipments: "=2.2", edi: "=2.3",
	products: "=3.1", product: "=3.1", pos: "=3.2", po: "=3.2", vendors: "=3.3",
	ledger: "=4.1", jobs: "=5.1", console: "=5.2", schedule: "=5.3", spool: "=5.4",
};

// Fields without a panel in their key are on the customer detail panel,
// the product panel, and so on; these say which.
const sharedFields: Record<string, string> = {
	id: "=1.2", name: "=1.2", addr: "=1.2", city: "=1.2", state: "=1.2", zip: "=1.2", phone: "=1.2",
	limit: "=1.2", status: "=1.2", job: "=5.1", sku: "=3.1", desc: "=3.1", price: "=3.1", onhand: "=3.1",
	reorder: "=3.1", po: "=3.2", vendor: "=3.2", cost: "=3.2", cartons: "=2.2", weight: "=2.2", carrier: "=2.2",
};

const concepts: Topic[] = [
	{
		id: "concept:invoice-lifecycle",
		title: "HOW AN INVOICE WORKS",
		text: "An invoice goes OPEN, then BILLED, then PAID. Lines can be added, changed or removed only while it is OPEN; " +
			"adding a line takes the stock off the shelf. PF6 on an open invoice releases it to the warehouse for shipping; once " +
			"released, PF10 bills it, which posts the total to the customer's balance (and sends an 810 for EDI customers). PF11 " +
			"on a billed invoice, or P beside it on the invoice list, marks it paid. Customers on HOLD " +
			"or CLOSED cannot get new invoices. Option 2.1, or I beside a customer on the browse list.",
		go: "=2.1",
	},
	{
		id: "concept:credit-hold",
		title: "CREDIT LIMITS AND HOLDS",
		text: "Each customer has a credit limit and a balance. A customer whose balance is over the limit can be put on HOLD " +
			"(status H) by changing the status on the customer panel (option 1.2, PF5 to update), or by the CUSCRREV credit " +
			"review job, which holds every active account over its limit. A held customer still takes payments but cannot get " +
			"new invoices. The credit exposure report is option 4.2.5.",
		go: "=1.2",
	},
	{
		id: "concept:shipping",
		title: "HOW SHIPPING WORKS",
		text: "Releasing an open invoice to the warehouse makes a shipment in status P (picking). Pack it with the number of " +
			"cartons and the weight (status K, packed), then ship it with a carrier, UPS, FDX or TRK (status S, shipped), which " +
			"gives it a tracking number and sends an 856 to EDI customers. The CUSPICK job prints pick tickets. Option 2.2.",
		go: "=2.2",
	},
	{
		id: "concept:tracking",
		title: "WHERE IS MY SHIPMENT",
		text: "Once a shipment has shipped, its carrier is asked where it is every half hour: in transit, out for delivery, " +
			"delivered (with who signed) or an exception such as a weather delay. Option 2.6 finds a shipment by its number, " +
			"invoice or tracking number and lists every carrier scan; PF5 asks the carrier again. A company truck delivery is " +
			"signed off by hand with PF10. Deliveries also show on the order timeline, option 2.4.",
		go: "=2.6",
	},
	{
		id: "concept:freight",
		title: "THE COMPANY TRUCKS",
		text: "Freight to OH, IN, KY, MI, PA and WV goes on the company's own trucks (carrier TRK). Once packed, those shipments wait " +
			"for a load: option 7.3 (PF6, or the CUSLOAD job) groups them by direction and weight into loads, each on the smallest " +
			"truck it fits, with a driver licensed for that truck who has hours left this week (60 in 7 days, 11 driving and 14 on " +
			"duty a day), its stops in the order that drives the fewest miles. Dispatching a load ships its shipments. On the load, " +
			"D beside a stop with who signed is its proof of delivery, X with why means it was not delivered and waits for another " +
			"load; PF10 when the truck is back, with every stop signed off, adds its miles to the odometer. Option 7.4 is the dispatch board. Trucks due for service (every 15,000 " +
			"miles or 90 days) or in the shop are not planned: option 7.1, V records a service. Option 7.5 is freight cost by " +
			"route: each load back costs its miles at the truck's cost per mile and the driver's hours at their rate, against what " +
			"UPS or FedEx would have charged; the month-end journal posts truck costs to 5210 and carrier charges to 5200.",
		go: "=7.3",
	},
	{
		id: "concept:edi",
		title: "EDI WITH CUSTOMERS AND VENDORS",
		text: "Trading partners exchange simulated X12 documents: an 850 purchase order from a customer opens an invoice, a 997 " +
			"acknowledges it, an 810 goes out when the invoice is billed, an 856 when it ships, and an 820 payment marks it paid. " +
			"Purchase orders go to vendors as 850s and come back as 855 confirmations and 856 ship notices. The EDISIM and VENDSIM " +
			"jobs play the partners. The EDI mailbox is option 2.3.",
		go: "=2.3",
	},
	{
		id: "concept:purchasing",
		title: "BUYING STOCK FROM VENDORS",
		text: "Purchase orders (option 3.2) go OPEN, SENT, CONFIRMED, IN TRANSIT and RECEIVED. Add lines while it is open, " +
			"send it to the vendor, and receive the goods when they arrive, which adds them to stock on hand. The CUSREORD job " +
			"raises purchase orders for every active product at or below its reorder point.",
		go: "=3.2",
	},
	{
		id: "concept:month-end",
		title: "MONTH-END CLOSE AND THE LEDGER",
		text: "The general ledger (option 4.1) shows the trial balance for a period. The CUSCLOSE job journals the period's " +
			"activity, prints the trial balance and closes the period; PF5 twice on the ledger panel does the same. CUSTRIAL " +
			"prints the trial balance without closing. CUSDUNN prints dunning letters for overdue invoices.",
		go: "=4.1",
	},
	{
		id: "concept:jobs",
		title: "BATCH JOBS AND ABENDS",
		text: "Submit a job by name on the batch jobs panel (option 5.1). It is queued, runs its steps, and leaves its output on " +
			"the spool with a return code: 0000 is clean, 0004 is a warning, ABEND means a step failed and the job stopped. S " +
			"beside a job shows its output; E, or PF6 on the output, asks the system to explain a failure. Jobs can run on a " +
			"schedule (option 5.3), and held output can be printed or purged (option 5.4).",
		go: "=5.1",
	},
	{
		id: "concept:cics",
		title: "CICS TRANSACTIONS, CEMT AND CEDF",
		text: "Every screen runs as a four-character CICS transaction. Press CLEAR on a menu (or option 5.9) and type an ID " +
			"such as CINQ 000105, ORDR or MENU; the IDs work on any menu too. CEMT I TRAN lists transactions with their uses " +
			"and abends, and CEMT S TRAN(ORDR) DIS disables one (overtype Ena or Dis to change it). CEDF stops each screen step " +
			"to show the EIB and commarea; CEDF OFF ends it. CEBR browses temporary storage queues: CSMT is the abend log. A " +
			"failed program abends with a code such as ASRA; PF6 on the abend screen explains it. CESF signs off.",
		go: "=5.9",
	},
	{
		id: "concept:console",
		title: "THE OPERATOR CONSOLE",
		text: "The operator console (option 5.2) shows the system log as it happens: logons, jobs starting and ending, abends, " +
			"scheduled releases. Commands on its command line: D T shows the time, D J the jobs queued or executing, D SCHED " +
			"the schedule; S jobname submits a job, H jobname holds its schedule and A jobname releases it.",
		go: "=5.2",
	},
	{
		id: "concept:search",
		title: "FINDING THINGS",
		text: "FIND text on any command line, or option 1.5, searches customers, invoices, purchase orders, shipments, vendors " +
			"and products by name or number. A question in plain English also works, such as FIND customers in Ohio over their " +
			"credit limit, or FIND open invoices over 5000. HELP followed by a question, such as HELP how do I put a customer " +
			"on hold, asks the system how to do something.",
		go: "=1.5",
	},
];

// topics returns the whole knowledge base.
export function topics(): Topic[] {
	const out: Topic[] = [];
	for (const o of menuTopics()) {
		const also = o.aliases.length ? ` Also called ${o.aliases.join(", ")}.` : "";
		out.push({
			id: `menu:${o.path}`,
			title: `OPTION ${o.path} ${o.name}`,
			text: `${o.name} on the ${o.menu}: ${o.desc}. Fast path =${o.path}, or type ${o.name} on any command line.${also}`,
			go: `=${o.path}`,
		});
	}
	for (const f of fieldTopics()) {
		const [panel, field] = f.key.includes(".") ? f.key.split(".") : ["", f.key];
		const values = f.values.length ? " Valid values: " + f.values.map((x) => `${x.code} ${x.desc}`).join("; ") + "." : "";
		out.push({
			id: `field:${f.key}`,
			title: `FIELD ${f.title}${panel ? ` ON ${panel.toUpperCase()}` : ""}`,
			text: f.lines.filter(Boolean).join(" ") + values,
			go: panel ? panelPaths[panel] : sharedFields[field],
		});
	}
	out.push({
		id: "keys",
		title: "KEYBOARD AND PF KEYS",
		text: tutorialKeys.map(([k, d]) => `${k}: ${d}`).join(". ") + ". PF1 is help, PF3 exits, PF7 and PF8 scroll, PF12 cancels.",
		go: "T",
	});
	for (const [name, j] of Object.entries(jobLibrary)) {
		out.push({
			id: `job:${name}`,
			title: `JOB ${name}`,
			text: `Batch job ${name}: ${j.title}. Steps ${j.steps.map((s) => s.name).join(", ")}. Submit it on option 5.1 or schedule it on 5.3.`,
			go: "=5.1",
		});
	}
	out.push(...concepts);
	return out;
}
