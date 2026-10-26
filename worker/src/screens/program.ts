// Panels are pseudo-conversational programs: the state they need between
// screens travels in the response's commarea, so the Worker keeps no
// session. A program's state is plain JSON tagged with its panel name.

import { HttpError } from "../http";
import type { Customer } from "../customer";
import type { Product } from "../products";
import type { Ctx, Screen } from "./screen";

export type Mode = "inquiry" | "update" | "add" | "delete";

export interface MenuState { p: "menu"; sub?: string; option?: string; msg?: string } // sub: the submenu shown, unset for the primary menu
export interface BrowseState {
	p: "browse";
	back?: MenuState; // the menu to return to; unset for the primary menu
	filter?: string; // name starts with
	city?: string; // city starts with
	state?: string;
	status?: string;
	top?: number;
	msg?: string;
	errSel?: string;
	errField?: string;
}
export interface DetailState {
	p: "detail";
	mode: Mode;
	back: State;
	cust?: Customer;
	loaded?: boolean;
	vals?: Record<string, string>; // operator input kept across a failed edit
	errField?: string;
	msg?: string;
}
export interface ReportState { p: "report"; back?: MenuState; msg?: string }
export interface ChartState {
	p: "chart";
	kind: "S" | "A" | "T" | "D"; // sales by month, receivables aging, inventory turns, the dashboard
	back: State;
	top?: number;
	msg?: string;
}
export interface HelpState {
	p: "help";
	back: State;
	field?: string; // help for that field
	vals?: Record<string, string>; // what the operator had typed on the screen, put back on return
	top?: number; // the first value shown, when the field has a list of them
	errSel?: string;
	msg?: string;
}
export interface ActivityState {
	p: "activity";
	back: State;
	id?: string;
	top?: number;
	errField?: string;
	msg?: string;
}
export interface EventState {
	p: "event";
	back: State;
	id: string; // the customer
	kind: "A" | "V" | "T" | "E" | "S" | "D"; // audit row, invoice, transaction, EDI interchange, shipment, dunning letter
	key: string;
	line: number; // its line on the event history
	msg?: string;
}

export interface JobsState {
	p: "jobs";
	back: State;
	job?: string; // the submit field, kept across a failed submit
	ids?: string[]; // job IDs on the rows shown, for the selection codes
	top?: number;
	errField?: string;
	errSel?: string;
	msg?: string;
}
export interface JobLogState { p: "joblog"; back: State; id: string; top?: number; msg?: string }

export interface ProductsState { p: "products"; back?: MenuState; filter?: string; top?: number; msg?: string; errSel?: string }
export interface ProductState {
	p: "product";
	mode: "inquiry" | "update" | "add";
	back: State;
	sku?: string; // the SKU typed when none was found
	prod?: Product;
	vals?: Record<string, string>; // operator input kept across a failed edit
	errField?: string;
	msg?: string;
}

export interface InvoicesState {
	p: "invoices";
	back: State;
	cust?: string; // only this customer's invoices; "" for all
	top?: number;
	errField?: string;
	errSel?: string;
	msg?: string;
}
export interface InvoiceState {
	p: "invoice";
	back: State;
	id: string;
	top?: number;
	vals?: Record<string, string>; // the add line fields, kept across a failed add
	confirm?: boolean; // PF9 was pressed once: press it again to cancel the invoice
	focus?: string; // the field to put the cursor in, once
	errField?: string;
	msg?: string;
}
export interface InvAddrState {
	p: "invaddr";
	back: InvoiceState;
	id: string;
	vals?: Record<string, string>; // the address fields, kept across a failed change
	errField?: string;
	msg?: string;
}
export interface SkuSearchState {
	p: "skusearch";
	back: InvoiceState;
	q: string; // matched against SKU and description
	top?: number;
	errSel?: string;
	msg?: string;
}

export interface EdiState {
	p: "edi";
	back: State;
	partner?: string; // only this customer's interchanges; "" for all
	top?: number;
	errField?: string;
	errSel?: string;
	msg?: string;
}
export interface EdiDocState { p: "edidoc"; back: State; id: string; top?: number; msg?: string }

export interface POsState {
	p: "pos";
	back: State;
	vendor?: string; // only this vendor's purchase orders; "" for all
	top?: number;
	errField?: string;
	errSel?: string;
	msg?: string;
}
export interface POState {
	p: "po";
	back: State;
	id: string;
	top?: number;
	vals?: Record<string, string>; // the add line fields, kept across a failed add
	confirm?: boolean; // PF9 was pressed once: press it again to cancel the PO
	errField?: string;
	msg?: string;
}
export interface ShipmentsState {
	p: "shipments";
	back: State;
	status?: string; // only shipments in this status: P, K or S; "" for all
	top?: number;
	errField?: string;
	errSel?: string;
	msg?: string;
}
export interface ShipmentState {
	p: "shipment";
	back: State;
	id: string;
	top?: number;
	vals?: Record<string, string>; // cartons and weight, kept across a failed step
	confirm?: boolean; // PF9 was pressed once: press it again to cancel the shipment
	errField?: string;
	msg?: string;
}
export interface LedgerState {
	p: "ledger";
	back: State;
	period?: string; // the period shown; "" for the open one
	confirm?: boolean; // PF5 was pressed once: press it again to close the period
	errField?: string;
	errSel?: string;
	msg?: string;
}
export interface GLAccountState { p: "glaccount"; back: State; account: string; period: string; top?: number; msg?: string }
export interface VendHistState {
	p: "vendhist";
	back: State;
	vendor?: string;
	po?: string; // only this purchase order's events; "" for all the vendor's
	top?: number;
	errField?: string;
	msg?: string;
}
export interface VendorsState { p: "vendors"; back: State; top?: number; errSel?: string; msg?: string }

export interface ConsoleState {
	p: "console";
	back: State;
	cmd?: string; // the command line, kept when a command fails
	top?: number; // the seq of the first line shown when scrolled back; unset follows the log
	first?: number; // the seqs of the first and last lines shown
	last?: number;
	msg?: string;
}
export interface ScheduleState {
	p: "schedule";
	back: State;
	vals?: Record<string, string>; // the job and cron fields, kept across a failed change
	names?: string[]; // the jobs on the rows shown, for the selection codes
	top?: number;
	errField?: string;
	errSel?: string;
	msg?: string;
}

export interface SpoolState {
	p: "spool";
	back: State;
	filter?: string; // job name starts with
	ids?: string[]; // the output groups on the rows shown, for the selection codes
	top?: number;
	errSel?: string;
	msg?: string;
}
export interface OutputState { p: "output"; back: State; id: string; top?: number; msg?: string }
export interface ArchiveState {
	p: "archive";
	back: State;
	filter?: string; // name or reference starts with
	kind?: "L" | "M" | "S" | "D" | ""; // only this kind of entry; "" for all
	keys?: string[]; // the entries on the rows shown, for the selection codes
	top?: number;
	errField?: string;
	errSel?: string;
	msg?: string;
}
export interface ArchDocState { p: "archdoc"; back: State; key: string; top?: number; msg?: string }

export interface MonitorState {
	p: "monitor";
	back: State;
	minutes?: number; // the window shown; 15 by default
	view?: "T" | "I"; // by transaction (the default) or by interval
	top?: number;
	msg?: string;
}
export interface TablesState { p: "tables"; back: State; names?: string[]; errSel?: string; msg?: string }
export interface TableRowsState {
	p: "tablerows";
	back: State;
	table: string;
	keys?: string[]; // the rows shown, for the selection codes
	top?: number;
	confirm?: boolean; // PF9 was pressed once: press it again to reset the table
	errSel?: string;
	msg?: string;
}
export interface TableRowState {
	p: "tablerow";
	back: TableRowsState;
	table: string;
	key?: string; // the row changed; unset to add one
	vals?: Record<string, string>; // operator input kept across a failed save
	errField?: string;
	msg?: string;
}

export interface SearchState {
	p: "search";
	back: State;
	q?: string; // what to look for
	type?: string; // only this type of record; "" for all
	top?: number;
	errField?: string;
	errSel?: string;
	msg?: string;
}

export type State =
	| MenuState | BrowseState | DetailState | ReportState | ChartState | HelpState | ActivityState | EventState
	| JobsState | JobLogState | ProductsState | ProductState | InvoicesState | InvoiceState | InvAddrState | SkuSearchState
	| EdiState | EdiDocState | POsState | POState | VendorsState | VendHistState | ShipmentsState | ShipmentState
	| LedgerState | GLAccountState | ConsoleState | ScheduleState | SpoolState | OutputState | SearchState
	| MonitorState | TablesState | TableRowsState | TableRowState | ArchiveState | ArchDocState;

// Input is what the operator sent with the AID key.
export interface Input {
	aid: string; // ENTER, CLEAR, PA1-PA3, PF1-PF24
	fields: Record<string, string>;
	modified: Set<string>;
	cursorField: string;
}

export interface Logoff { logoff: string }

export type Next = State | Logoff;

// Program renders a panel from its state and handles an AID key, returning
// the state to show next (the same object to stay) or a logoff.
export interface Program<S extends State> {
	render(ctx: Ctx, s: S): Promise<Screen>;
	handle(ctx: Ctx, s: S, input: Input): Promise<Next>;
	// locks names the records the panel holds for update while it shows s,
	// such as "CUSTOMER 000101". The session keeps exactly these (and those
	// of the panels under it) locked, so another terminal is told the
	// record is in use (screens/index.ts, sessions.ts).
	locks?(s: S): string[];
	// unlocked returns the panel without its locks, after it lost them to
	// another session: back to inquiry, nothing saved.
	unlocked?(s: S): State;
}

// Fill puts values in a panel's input fields the next time it is drawn,
// with their modified data tags set as if the operator had typed them:
// what was typed before PF1, a value picked from a prompt list, or a
// retrieved command. It travels on the state for one screen only.
export interface Fill {
	fields: Record<string, string>;
	cursor?: string; // the field to put the cursor in
}

export function withFill<S extends State>(s: S, fill: Fill): S {
	(s as S & { fill?: Fill }).fill = fill;
	return s;
}

// takeFill removes the fill from a state and returns it.
export function takeFill(s: State): Fill | undefined {
	const st = s as State & { fill?: Fill };
	const fill = st.fill;
	delete st.fill;
	return fill;
}

// Download hands the operator a file along with the next screen: the client
// fetches url (an API path, signed on the same way) and saves or opens it
// as name. Like a fill, it travels on the state for one screen only.
export interface Download {
	url: string;
	name: string;
}

export function withDownload<S extends State>(s: S, d: Download): S {
	(s as S & { download?: Download }).download = d;
	return s;
}

export function takeDownload(s: State): Download | undefined {
	const st = s as State & { download?: Download };
	const d = st.download;
	delete st.download;
	return d;
}

export function pf(n: number): string {
	return `PF${n}`;
}

// fail turns an unexpected API error into a message for the message line.
export function fail(err: unknown): string {
	if (err instanceof HttpError) return "CUS0299E " + err.message.toUpperCase();
	throw err;
}

export function isCode(err: unknown, code: string): err is HttpError {
	return err instanceof HttpError && err.code === code;
}

// messenger panels can show a message passed back from a child screen.
export function setMsg(s: State, msg: string): boolean {
	if (s.p === "browse" || s.p === "menu" || s.p === "invoices" || s.p === "edi" || s.p === "pos" || s.p === "shipments") {
		s.msg = msg;
		return true;
	}
	return false;
}
