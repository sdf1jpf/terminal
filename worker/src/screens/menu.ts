import { newActivity } from "./activity";
import { newAdd, newInquiry } from "./detail";
import { newEdi } from "./edi";
import { newInvoices } from "./invoices";
import { newPOs } from "./purchasing";
import { newShipments } from "./shipping";
import { newLedger } from "./ledger";
import { invalidKey, header, keys, label, message, newScreen, time, type Ctx } from "./screen";
import { pf, type MenuState, type Next, type Program } from "./program";

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
	go?: (ctx: Ctx, m: MenuState, arg: string) => Next | Promise<Next>;
}

interface Menu { map: string; title: string; options: Option[] }

const menus: Record<string, Menu> = {
	"": {
		map: "CUSM00",
		title: "PRIMARY OPTION MENU",
		options: [
			{ key: "1", name: "CUSTOMERS", desc: "Customer master, inquiry, events", sub: "1" },
			{ key: "2", name: "ORDERS", desc: "Invoices, shipping, EDI", sub: "2" },
			{ key: "3", name: "INVENTORY", desc: "Products, purchasing, vendors", sub: "3" },
			{ key: "4", name: "ACCOUNTING", desc: "Ledger, close, dunning, credit", sub: "4" },
			{ key: "5", name: "OPERATIONS", desc: "Jobs, console, schedule, output", sub: "5" },
			{ key: "T", name: "TUTORIAL", desc: "Keyboard and PF keys", aliases: ["T", "HELP"], go: (_ctx, m) => ({ p: "help", back: m }) },
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
		],
	},
	"2": {
		map: "CUSM20",
		title: "ORDER MENU",
		options: [
			{ key: "1", name: "INVOICES", desc: "Build, bill, collect", go: (_ctx, m, arg) => newInvoices(m, arg) },
			{ key: "2", name: "SHIPPING", desc: "Pick, pack and ship", aliases: ["S", "SHIPMENTS"], go: (_ctx, m, arg) => newShipments(m, arg) },
			{ key: "3", name: "EDI", desc: "EDI mailbox", aliases: ["E"], go: (_ctx, m, arg) => newEdi(m, arg) },
		],
	},
	"3": {
		map: "CUSM30",
		title: "INVENTORY MENU",
		options: [
			{ key: "1", name: "PRODUCTS", desc: "Products and stock", go: (_ctx, m, arg) => ({ p: "products", back: m, filter: arg }) },
			{ key: "2", name: "PURCHASING", desc: "Purchase orders", aliases: ["P", "PO"], go: (_ctx, m, arg) => newPOs(m, arg) },
			{ key: "3", name: "VENDORS", desc: "Vendor list", go: (_ctx, m) => ({ p: "vendors", back: m }) },
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
			{ key: "2", name: "REPORTS", desc: "Credit exposure summary", aliases: ["CREDIT"], go: (_ctx, m) => ({ p: "report", back: m }) },
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
			scr.text(21, 4, "to a customer. Press PF1 at any time for help.", { color: "blue" });
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
				if (m.sub) return { p: "menu" };
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
			return opt.go(ctx, back, arg);
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
