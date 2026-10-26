// The TSO address space: greenscreen's Sessions Durable Object knows who is
// signed on, which records they hold for update, and the messages users
// SEND each other, and keeps the terminals' WebSocket connections (GET
// /v1/live). This subclass adds the console watcher, so the operator
// console follows SYSLOG without every terminal polling for it.

import { HttpError } from "@greenscreen-dev/worker";
import { Sessions as TsoAddressSpace, tso as stub } from "@greenscreen-dev/worker/sessions";
import type { Env } from "./index";

export { USER_HEADER } from "@greenscreen-dev/worker";

export class Sessions extends TsoAddressSpace<Env> {
	protected watchMs = 1_000;

	// watch looks at the end of SYSLOG every second while any terminal
	// listens, and tells them when it moves. Every writer of the log (jobs,
	// the scheduler, commands, logons) is covered without having to call in.
	protected async watch(): Promise<void> {
		const row = await this.env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM syslog").first<{ seq: number }>();
		const seq = row?.seq ?? 0;
		const last = this.counter("syslog");
		if (seq !== last) {
			this.setCounter("syslog", seq);
			if (last !== 0) this.push({ event: "syslog", seq });
		}
	}
}

// tso returns the system's one Sessions object.
export function tso(env: { SESSIONS: DurableObjectNamespace<Sessions> }): DurableObjectStub<Sessions> {
	return stub(env.SESSIONS);
}

// notLocked refuses a change to resource made outside the terminal (the
// REST API) while another user has it locked for update in one.
export async function notLocked(env: { SESSIONS: DurableObjectNamespace<Sessions> }, resource: string, user: string): Promise<void> {
	const h = await tso(env).holder(resource);
	if (h && h.user !== user) {
		throw new HttpError(423, "locked", `record in use by ${h.user} on ${h.terminal}`);
	}
}
