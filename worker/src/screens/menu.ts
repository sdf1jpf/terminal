import { newActivity } from "./activity";
import { newAsk } from "./ask";
import { newChart } from "./charts";
import { newAdd, newInquiry } from "./detail";
import { newEdi } from "./edi";
import { newInvoices } from "./invoices";
import { newPOs } from "./purchasing";
import { newShipments } from "./shipping";
import { newTracking } from "./tracking";
import { newLoads } from "./loads";
import { newLedger } from "./ledger";
import { find } from "./search";
import { newVendHist } from "./vendhist";
import { newTimeline } from "./timeline";
import { newEdiEx } from "./ediex";
import { invalidKey, header, keys, label, message, newScreen, time, type Ctx } from "./screen";
import { pf, type MenuState, type Next, type Program, type State } from "./program";

// The ISPF-style primary option menu and its submenus, one per module.
// An option is picked by its key on the menu shown, by a fast path from
// the primary menu such as 1.2 or =1.2, or by its name (or an alias) from
// any menu. A second word is passed to the option, so 1.2 000105 jumps
// straight to that customer.

interface Option {
	key: string;
	name: string;
	desc: string;
	aliases?: string[];
	sub?: string; // opens this submenu
	go?: (ctx: Ctx, m: MenuState, arg: string, rest: string) => Next | Promise<Next>; // rest: every word after the option
}

interface Menu { map: string; title: string; parent?: string; options: Option[] } // parent: the menu PF3 returns to, for a submenu of a submenu

const menus: Record<string, Menu> = {
	"": {
		map: "CUSM00",
		title: "PRIMARY OPTION MENU",
		options: [
			{ key: "1", name: "CUSTOMERS", desc: "Customer master, inquiry, events", sub: "1" },
			{ key: "2", name: "ORDERS", desc: "Invoices, shipping, EDI", sub: "2" },
			{ key: "3", name: "INVENTORY", desc: "Products, purchasing, vendors", sub: "3" },
			{ key: "4", name: "ACCOUNTING", desc: "Ledger, close, dunning, credit", sub: "4" },
			{ key: "5", name: "OPERATIONS", desc: "Jobs, console, output, monitor, tables", sub: "5" },
			{ key: "7", name: "FREIGHT", desc: "Trucks, drivers, loads, dispatch", sub: "7" },
			{
				key: "T", name: "TUTORIAL", desc: "Keyboard and PF keys; HELP and a question", aliases: ["T", "HELP", "ASK"],
				go: (ctx, m, _arg, rest) => (rest ? newAsk(ctx, m, rest) : { p: "help", back: m }),
			},
			{ key: "X", name: "EXIT", desc: "Log off", aliases: ["X", "LOGOFF"], go: (ctx) => logoff(ctx) },
		],
	},
	"1": {
		map: "CUSM10",
		title: "CUSTOMER MENU",
		options: [
			{ key: "1", name: "BROWSE", desc: "Customer master file", go: (_ctx, m, arg) => ({ p: "browse", back: m, filter: arg }) },
			{ key: "2", name: "INQUIRY", desc: "Customer by number", go: (ctx, m, arg) => newInquiry(ctx, m, arg) },
			{ key: "3", name: "ADD", desc: "Add a new customer", go: (_ctx, m) => newAdd(m) },
			{
				key: "4", name: "EVENTS", desc: "Customer event history", aliases: ["ACTIVITY", "HISTORY"],
				go: (ctx, m, arg) => newActivity(ctx, m, arg),
			},
			{
				key: "5", name: "SEARCH", desc: "Find anything by name or number", aliases: ["FIND"],
				go: (ctx, m, _arg, rest) => find(ctx, m, rest),
			},
		],
	},
	"2": {
		map: "CUSM20",
		title: "ORDER MENU",
		options: [
			{ key: "1", name: "INVOICES", desc: "Build, bill, collect", go: (_ctx, m, arg) => newInvoices(m, arg) },
			{ key: "2", name: "SHIPPING", desc: "Pick, pack and ship", aliases: ["S", "SHIPMENTS"], go: (_ctx, m, arg) => newShipments(m, arg) },
			{ key: "3", name: "EDI", desc: "EDI mailbox", aliases: ["E"], go: (_ctx, m, arg) => newEdi(m, arg) },
			{ key: "4", name: "TIMELINE", desc: "Order lifecycle timeline", aliases: ["TL", "LIFECYCLE"], go: (_ctx, m, arg) => newTimeline(m, arg) },
			{ key: "5", name: "EXCEPTIONS", desc: "EDI lines held to correct", aliases: ["EX", "EDIEX"], go: (_ctx, m) => newEdiEx(m) },
			{ key: "6", name: "TRACKING", desc: "Where a shipment is", aliases: ["TRACK"], go: (_ctx, m, arg) => newTracking(m, arg) },
		],
	},
	"3": {
		map: "CUSM30",
		title: "INVENTORY MENU",
		options: [
			{ key: "1", name: "PRODUCTS", desc: "Products and stock", go: (_ctx, m, arg) => ({ p: "products", back: m, filter: arg }) },
			{ key: "2", name: "PURCHASING", desc: "Purchase orders", aliases: ["P", "PO"], go: (_ctx, m, arg) => newPOs(m, arg) },
			{ key: "3", name: "VENDORS", desc: "Vendor list", go: (_ctx, m) => ({ p: "vendors", back: m }) },
			{
				key: "4", name: "VHISTORY", desc: "Vendor and PO history", aliases: ["VH", "POHIST"],
				go: (_ctx, m, arg, rest) => newVendHist(m, arg, rest.split(/\s+/)[1] ?? ""),
			},
			{
				key: "5", name: "POTIMELINE", desc: "Purchase order lifecycle", aliases: ["POTL"],
				go: (_ctx, m, arg) => newTimeline(m, arg ? (/^po/i.test(arg) ? arg : "PO" + arg) : ""),
			},
		],
	},
	"4": {
		map: "CUSM40",
		title: "ACCOUNTING MENU",
		options: [
			{
				key: "1", name: "LEDGER", desc: "Trial balance, close, dunning", aliases: ["A", "ACCOUNTS"],
				go: (_ctx, m, arg) => newLedger(m, arg),
			},
			{ key: "2", name: "REPORTS", desc: "Dashboard, sales, aging, turns", sub: "4.2" },
		],
	},
	"4.2": {
		map: "CUSM42",
		title: "REPORTS MENU",
		parent: "4",
		options: [
			{ key: "1", name: "DASHBOARD", desc: "Management dashboard", aliases: ["DASH"], go: (_ctx, m) => newChart("D", m) },
			{ key: "2", name: "SALES", desc: "Sales by month", go: (_ctx, m) => newChart("S", m) },
			{ key: "3", name: "AGING", desc: "Receivables aging buckets", go: (_ctx, m) => newChart("A", m) },
			{ key: "4", name: "TURNS", desc: "Inventory turns by product", go: (_ctx, m) => newChart("T", m) },
			{ key: "5", name: "CREDIT", desc: "Credit exposure summary", go: (_ctx, m) => ({ p: "report", back: m }) },
		],
	},
	"5": {
		map: "CUSM50",
		title: "OPERATIONS MENU",
		options: [
			{ key: "1", name: "JOBS", desc: "Submit batch jobs, job logs", go: (_ctx, m) => ({ p: "jobs", back: m }) },
			{ key: "2", name: "CONSOLE", desc: "Operator console, SYSLOG", aliases: ["O", "OPERATOR", "LOG", "SYSLOG"], go: (_ctx, m) => ({ p: "console", back: m }) },
			{ key: "3", name: "SCHEDULE", desc: "Job schedule", go: (_ctx, m) => ({ p: "schedule", back: m }) },
			{ key: "4", name: "HELD", desc: "Held output, reprint", aliases: ["H", "SPOOL", "OUTPUT"], go: (_ctx, m, arg) => ({ p: "spool", back: m, filter: arg }) },
			{ key: "5", name: "MONITOR", desc: "Transaction rates, response times", aliases: ["STATS", "CEMT"], go: (_ctx, m) => ({ p: "monitor", back: m }) },
			{ key: "6", name: "TABLES", desc: "Carrier rates, tax codes, help text", aliases: ["SYSTABLES"], go: (_ctx, m) => ({ p: "tables", back: m }) },
			{ key: "7", name: "ARCHIVE", desc: "Archived output (R2)", aliases: ["R2"], go: (_ctx, m, arg) => ({ p: "archive", back: m, filter: arg.toUpperCase() }) },
			{ key: "8", name: "MAIL", desc: "Mail sent and received", aliases: ["EMAIL"], go: (_ctx, m, arg) => ({ p: "mail", back: m, ref: arg.toUpperCase() }) },
		],
	},
	"7": {
		map: "CUSM70",
		title: "FREIGHT OPERATIONS MENU",
		options: [
			{ key: "1", name: "TRUCKS", desc: "Fleet and maintenance", aliases: ["FLEET"], go: (_ctx, m) => ({ p: "trucks", back: m }) },
			{ key: "2", name: "DRIVERS", desc: "Drivers, licenses, hours", go: (_ctx, m) => ({ p: "drivers", back: m }) },
			{ key: "3", name: "LOADS", desc: "Plan and dispatch loads", aliases: ["PLAN", "LOAD"], go: (_ctx, m, arg) => newLoads(m, arg) },
			{ key: "4", name: "DISPATCH", desc: "Dispatch board", aliases: ["BOARD"], go: (_ctx, m, arg) => ({ p: "board", back: m, day: arg }) },
		],
	},
};

const NAME_WIDTH = 12;

export function logoff(ctx: Ctx): Next {
	return { logoff: `IKJ56470I ${ctx.user} LOGGED OFF AT ${time(ctx)}` };
}

function current(m: MenuState): Menu {
	return menus[m.sub ?? ""] ?? menus[""];
}

// menuValues lists the options on the menu s shows, for the option
// field's prompt list.
export function menuValues(s: State): { code: string; desc: string }[] {
	const mn = s.p === "menu" ? current(s) : menus[""];
	return mn.options.map((o) => ({ code: o.key, desc: `${o.name} - ${o.desc}`.toUpperCase() }));
}

// menuTopics lists every option with its fast path, for the HELP
// facility's knowledge base (knowledge.ts).
export function menuTopics(): { path: string; name: string; desc: string; aliases: string[]; menu: string }[] {
	const out: { path: string; name: string; desc: string; aliases: string[]; menu: string }[] = [];
	for (const [k, menu] of Object.entries(menus)) {
		for (const o of menu.options) {
			out.push({ path: k ? `${k}.${o.key}` : o.key, name: o.name, desc: o.desc, aliases: o.aliases ?? [], menu: menu.title });
		}
	}
	return out;
}

// byName finds an option by name or alias on any menu.
function byName(word: string): Option | undefined {
	for (const menu of Object.values(menus)) {
		for (const o of menu.options) if (o.name === word || o.aliases?.includes(word)) return o;
	}
	return undefined;
}

export const menu: Program<MenuState> = {
	async render(ctx, m) {
		const primary = !m.sub || !menus[m.sub];
		const mn = current(m);
		const scr = newScreen(ctx, mn.map);
		header(scr, ctx, mn.title);

		label(scr, 4, 2, "OPTION ===>");
		scr.input(4, 14, 40, "option", m.option ?? "");

		mn.options.forEach(({ key, name, desc }, i) => {
			scr.text(6 + i, 4, key, { color: "white", bright: true });
			scr.text(6 + i, 7, name, { color: "turquoise" });
			scr.text(6 + i, 7 + NAME_WIDTH, desc, { color: "green" });
		});

		if (primary) {
			const info = [
				["USERID", ctx.user],
				["TERMINAL", ctx.terminal],
				["SYSTEM", ctx.system],
				["HOST", ctx.host.toUpperCase().slice(0, 30)],
			];
			const row = 7 + mn.options.length;
			let col = 4;
			for (const [k, v] of info) {
				if (col + k.length + v.length + 1 > scr.cols) break;
				label(scr, row, col, k);
				scr.text(row, col + k.length + 1, v, { color: "white" });
				col += k.length + v.length + 4;
			}
			scr.text(20, 4, "Enter an option, or a fast path such as 1.2 000105 to jump straight", { color: "blue" });
			scr.text(21, 4, "to a customer. PF1 is help; HELP and a question asks the system.", { color: "blue" });
		} else {
			scr.text(20, 4, "Enter an option, or a name such as INQUIRY 000105. PF3 returns to the", { color: "blue" });
			scr.text(21, 4, "primary menu, and =X logs off.", { color: "blue" });
		}

		message(scr, m.msg ?? "");
		keys(scr, `PF1=HELP  PF3=${primary ? "LOGOFF" : "RETURN"}  PF4=BROWSE  PF12=CANCEL`);
		scr.cursorTo("option");
		return scr;
	},

	async handle(ctx, m, input) {
		m.msg = "";
		switch (input.aid) {
			case "ENTER":
				break;
			case pf(3):
				if (m.sub) return menus[m.sub]?.parent ? { p: "menu", sub: menus[m.sub].parent } : { p: "menu" };
				return logoff(ctx);
			case pf(4):
				return { p: "browse", back: m };
			case pf(12):
			case "CLEAR":
				m.option = "";
				return m;
			default:
				m.msg = invalidKey(input.aid);
				return m;
		}

		const words = (input.fields.option ?? "").toUpperCase().split(/\s+/).filter(Boolean);
		m.option = "";
		if (words.length === 0) return m;
		const arg = words[1] ?? "";

		// A leading = or a dotted path starts from the primary menu.
		let cmd = words[0];
		let mn = current(m);
		if (cmd.startsWith("=") || cmd.includes(".")) {
			cmd = cmd.replace(/^=/, "");
			mn = menus[""];
		}
		if (cmd === "") return { p: "menu" };

		const path = cmd.split(".");
		let opt = path.length === 1 ? mn.options.find((o) => o.key === cmd) ?? byName(cmd) : undefined;
		for (let i = 0; i < path.length && path.length > 1; i++) {
			opt = mn.options.find((o) => o.key === path[i]);
			if (!opt || i === path.length - 1) break;
			if (!opt.sub) {
				opt = undefined; // the path goes on past an option
				break;
			}
			mn = menus[opt.sub];
		}
		if (opt?.sub) return { p: "menu", sub: opt.sub };
		if (opt?.go) {
			// The option returns to the menu it is on, which a fast path or a
			// name may have skipped past.
			const home = menuOf(opt);
			const back: MenuState = home === (m.sub ?? "") ? m : home ? { p: "menu", sub: home } : { p: "menu" };
			return opt.go(ctx, back, arg, words.slice(1).join(" "));
		}
		m.option = words.join(" ");
		m.msg = "ISPD117E INVALID OPTION " + words[0];
		return m;
	},
};

// menuOf is the key of the menu an option is on.
function menuOf(opt: Option): string {
	for (const [k, menu] of Object.entries(menus)) if (menu.options.includes(opt)) return k;
	return "";
}
