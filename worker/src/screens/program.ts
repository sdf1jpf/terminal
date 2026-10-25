// Panels are pseudo-conversational programs: the state they need between
// screens travels in the response's commarea, so the Worker keeps no
// session. A program's state is plain JSON tagged with its panel name.

import { HttpError } from "../http";
import type { Customer } from "../customer";
import type { Ctx, Screen } from "./screen";

export type Mode = "inquiry" | "update" | "add" | "delete";

export interface MenuState { p: "menu"; option?: string; msg?: string }
export interface BrowseState { p: "browse"; filter?: string; top?: number; msg?: string; errSel?: string }
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
export interface ReportState { p: "report"; msg?: string }
export interface HelpState { p: "help"; back: State }
export interface ActivityState {
	p: "activity";
	back: State;
	id?: string;
	top?: number;
	vals?: Record<string, string>; // posting fields kept across a failed post
	errField?: string;
	msg?: string;
}
export interface HistoryState { p: "history"; back: State; id?: string; top?: number; errField?: string; msg?: string }

export type State = MenuState | BrowseState | DetailState | ReportState | HelpState | ActivityState | HistoryState;

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
	if (s.p === "browse" || s.p === "menu") {
		s.msg = msg;
		return true;
	}
	return false;
}
