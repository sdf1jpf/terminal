// POST /v1/screen: the terminal's screens, served by greenscreen's screen
// engine (protocol in docs/screen-protocol.md). A client sends the AID key,
// its input fields and the commarea from the last reply; the engine runs the
// panel the commarea names and answers with the next screen. This module
// registers the panels and what the engine needs from this system.

import type { Env } from "../index";
import { syslog } from "../syslog";
import { activity, event } from "./activity";
import { archdoc, archive } from "./archive";
import { mail, mailmsg } from "./mail";
import { ask } from "./ask";
import { browse } from "./browse";
import { chart } from "./charts";
import { opconsole, schedule } from "./console";
import { detail } from "./detail";
import { helpFor } from "./fieldhelp";
import { edi, edidoc } from "./edi";
import { help } from "./help";
import { invaddr, invoice, invoices } from "./invoices";
import { joblog, jobs } from "./jobs";
import { product, products } from "./products";
import { po, pos, vendors } from "./purchasing";
import { vendhist } from "./vendhist";
import { timelinePanel } from "./timeline";
import { ediex } from "./ediex";
import { shipment, shipments } from "./shipping";
import { tracking } from "./tracking";
import { drivers, fleetitem, trucks } from "./fleet";
import { dispatchBoard, load, loads } from "./loads";
import { glaccount, ledger } from "./ledger";
import { menu } from "./menu";
import { monitor } from "./monitor";
import { tablerow, tablerows, tables } from "./tables";
import { report } from "./report";
import { pricing, salespeople, salesrpt, territories } from "./sales";
import { search } from "./search";
import { skusearch } from "./skusearch";
import { output, spool } from "./spool";
import { screenHandler, sendCommand, type ScreenConfig } from "@greenscreen-dev/worker";
import { tso } from "../sessions";
import type { Ctx } from "./screen";
import type { Program, State } from "./program";

export { requestKeys, type ScreenResponse } from "@greenscreen-dev/worker";

const programs: { [P in State["p"]]: Program<Extract<State, { p: P }>> } = {
	menu, browse, detail, report, chart, help, activity, event, jobs, joblog, products, product, invoices, invoice, invaddr, skusearch, edi, edidoc,
	pos, po, vendors, vendhist, timeline: timelinePanel, ediex, shipments, shipment, tracking, trucks, drivers, fleetitem, loads, load, board: dispatchBoard, ledger, glaccount,
	console: opconsole, schedule, spool, output, search, monitor, tables, tablerows, tablerow, ask, archive, archdoc, mail, mailmsg,
	pricing, territories, salespeople, salesrpt,
};

export const config: ScreenConfig<Env> = {
	app: { title: "CUSTOMER INFORMATION SYSTEM", prefix: "CUS", system: "SYS1", tagline: "MODERN MAINFRAME EXPERIENCE" },
	programs,
	// The menu, console and ask panels have command lines: PF24 (RETRIEVE,
	// as in ISPF) puts back what was entered there, newest first.
	commandLines: { menu: "option", console: "cmd", ask: "q" },
	// Field help text lives in the HELP system table, so operators can change
	// it. The engine only asks whether a field has any; help.ts draws it.
	fieldHelp: async (s, field, ctx) => ((await helpFor((ctx as Ctx).tables, s as State, field)) ? { title: field, lines: [] } : undefined),
	// Every panel gets this system's bindings by name (screens/screen.ts Ctx).
	context: (ctx) => ({ db: ctx.env.DB, tables: ctx.env.TABLES, jobs: ctx.env.JOBS, tso: tso(ctx.env) }),
	sessions: (env) => tso(env),
	// SEND works from any command line, as a TSO command does. Without
	// USER it goes to the operator, on SYSLOG.
	commands: sendCommand<Env>({
		mailbox: (ctx) => (ctx as Ctx).tso,
		operator: (ctx, text) => syslog(ctx.env.DB, ctx.user, `IKJ79154I ${text}  FROM ${ctx.user}`.slice(0, 200)),
	}),
	// Logons, logoffs and idle timeouts go on SYSLOG.
	onEvent: (ctx, e) => syslog(ctx.env.DB, ctx.user, e.text),
};

export const screen = screenHandler(config);
