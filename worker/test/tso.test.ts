import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseSend } from "@greenscreen-dev/worker";
import { tso, type Sessions } from "../src/sessions";
import { syslog } from "../src/syslog";
import { accessJWT } from "./access";
import { Terminal, worker } from "./term";

async function rest(method: string, path: string, user: string, body?: unknown) {
	const res = await worker.fetch(`https://api.test${path}`, {
		method,
		headers: { "Cf-Access-Jwt-Assertion": await accessJWT({ email: `${user}@example.com` }), "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: res.status === 204 ? null : await res.json<any>() };
}

// lapse ends the session holding resource, as if its terminal had been
// left for longer than the idle limit.
async function lapse(resource: string) {
	await runInDurableObject(tso(env), async (_o: Sessions, state) => {
		state.storage.sql.exec("UPDATE sessions SET seen = 0 WHERE sid IN (SELECT sid FROM locks WHERE resource = ?)", resource);
	});
}

// listen opens GET /v1/live as user and collects the events it gets.
async function listen(user: string) {
	const res = await worker.fetch("https://api.test/v1/live", {
		headers: { Upgrade: "websocket", "Cf-Access-Jwt-Assertion": await accessJWT({ email: `${user}@example.com` }) },
	});
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	ws.accept();
	const events: any[] = [];
	ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
	const next = async () => {
		for (let i = 0; i < 100 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
		return events.shift();
	};
	return { ws, events, next };
}

describe("record locking", () => {
	it("tells a second user the customer is in use until the first is done", async () => {
		const a = await Terminal.logon();
		await a.fill("option", "1.2 108").send("ENTER");
		await a.send("PF4");
		expect(a.row(1)).toContain("UPDATE");

		const b = await Terminal.as("JFRANK");
		await b.fill("option", "1.2 108").send("ENTER");
		await b.send("PF4");
		expect(b.message).toBe("CUS1201E RECORD IN USE BY IBMUSER ON TERM0001 - CUSTOMER 000108");
		expect(b.field("name")).toBeUndefined(); // still inquiry

		// The REST API is refused too, except for the holder.
		const cust = (await rest("GET", "/v1/customers/000108", "jfrank")).body;
		const put = await rest("PUT", "/v1/customers/000108", "jfrank", { ...cust, phone: "555-0100" });
		expect(put.status).toBe(423);
		expect(put.body.error).toEqual({ code: "locked", message: "record in use by IBMUSER on TERM0001" });
		expect((await rest("DELETE", "/v1/customers/000108", "jfrank")).status).toBe(423);

		// PF1 help over the update screen keeps the lock.
		await a.send("PF1");
		await b.send("PF4");
		expect(b.message).toMatch(/^CUS1201E/);
		await a.send("PF3");

		await a.send("PF12");
		expect(a.message).toBe("CUS0210I UPDATE CANCELLED, NO CHANGES MADE");
		await b.send("PF4");
		expect(b.message).toBe("");
		expect(b.field("name")).toBeDefined();
	});

	it("counts the same user on another terminal as someone else", async () => {
		const a = await Terminal.logon();
		await a.fill("option", "1.2 110").send("ENTER");
		await a.send("PF9"); // delete holds the record too
		expect(a.row(1)).toContain("DELETE");
		const b = await Terminal.as("IBMUSER", "TERM0009");
		await b.fill("option", "1.2 110").send("ENTER");
		await b.send("PF4");
		expect(b.message).toBe("CUS1201E RECORD IN USE BY IBMUSER ON TERM0001 - CUSTOMER 000110");
	});

	it("releases the locks at logoff and time-out", async () => {
		const a = await Terminal.logon();
		await a.fill("option", "1.2 111").send("ENTER");
		await a.send("PF4");
		await a.send("TIMEOUT");
		expect(a.logoff).toMatch(/S522/);

		const b = await Terminal.as("JFRANK");
		await b.fill("option", "1.2 111").send("ENTER");
		await b.send("PF4");
		expect(b.field("name")).toBeDefined();
	});

	it("locks a product picked for update from the product list", async () => {
		const a = await Terminal.logon();
		await a.fill("option", "3.1 BLT").send("ENTER");
		const sku = a.scr.fields.find((f) => f.name?.startsWith("sel:"))!.name!.slice(4);
		await a.fill(`sel:${sku}`, "u").send("ENTER");
		expect(a.row(1)).toContain("UPDATE");

		const b = await Terminal.as("JFRANK");
		await b.fill("option", "3.1 BLT").send("ENTER");
		await b.fill(`sel:${sku}`, "u").send("ENTER");
		expect(b.scr.map).toBe("CUSP01");
		expect(b.message).toBe(`CUS1201E RECORD IN USE BY IBMUSER ON TERM0001 - PRODUCT ${sku}`);
		const prod = (await rest("GET", `/v1/products/${sku}`, "jfrank")).body;
		expect((await rest("PUT", `/v1/products/${sku}`, "jfrank", prod)).status).toBe(423);
		expect((await rest("PUT", `/v1/products/${sku}`, "ibmuser", prod)).status).not.toBe(423);
	});

	it("does not save a change once the lock has gone to someone else", async () => {
		const a = await Terminal.logon();
		await a.fill("option", "1.2 109").send("ENTER");
		await a.send("PF4");
		await lapse("CUSTOMER 000109");

		const b = await Terminal.as("JFRANK");
		await b.fill("option", "1.2 109").send("ENTER");
		await b.send("PF4");
		expect(b.field("name")).toBeDefined();

		await a.fill("city", "kettering").send("ENTER");
		expect(a.message).toBe("CUS1202E LOCK LOST TO JFRANK ON TERM0002 - CUSTOMER 000109 NOT CHANGED");
		expect(a.field("name")).toBeUndefined();
		expect((await rest("GET", "/v1/customers/000109", "ibmuser")).body.city).not.toBe("KETTERING");
	});
});

describe("SEND", () => {
	it("parses TSO's operands", () => {
		expect(parseSend("SEND 'LUNCH AT NOON?' USER(JFRANK)")).toEqual({ text: "LUNCH AT NOON?", users: ["JFRANK"], logon: false });
		expect(parseSend("SE 'IT''S DOWN',U(A,B) LOGON")).toEqual({ text: "IT'S DOWN", users: ["A", "B"], logon: true });
		expect(parseSend("TSO SEND 'HI' USER(*)")).toEqual({ text: "HI", users: ["*"], logon: false });
		expect(parseSend("SEND 'PRINTER JAMMED'")).toEqual({ text: "PRINTER JAMMED", users: [], logon: false });
		expect(() => parseSend("SEND HELLO")).toThrow(/enter SEND/);
		expect(() => parseSend("SEND 'X' USER(TOOLONGUSER)")).toThrow(/userids/);
		expect(() => parseSend("SEND 'X' USER(A) LATER")).toThrow(/unknown SEND operand LATER/);
	});

	it("shows a message on the receiver's next screen", async () => {
		const b = await Terminal.as("MSGTO");
		const a = await Terminal.logon();
		await a.fill("option", "send 'lunch at noon?' user(msgto)").send("ENTER");
		expect(a.message).toBe("CUS1210I MESSAGE SENT TO MSGTO");
		expect(a.scr.map).toBe("CUSM00");

		await b.send("ENTER");
		expect(b.message).toBe("LUNCH AT NOON?  FROM IBMUSER");
		await b.send("ENTER");
		expect(b.message).not.toContain("LUNCH");
	});

	it("keeps it for a user who is not on only with LOGON", async () => {
		const a = await Terminal.logon();
		await a.fill("option", "send 'call me' user(later)").send("ENTER");
		expect(a.message).toBe("CUS1211W LATER NOT LOGGED ON - ADD LOGON TO KEEP THE MESSAGE FOR THEM");
		await a.fill("option", "send 'call me' user(later) logon").send("ENTER");
		expect(a.message).toBe("CUS1210I MESSAGE SENT OR SAVED FOR LATER");
		const b = await Terminal.as("LATER");
		expect(b.message).toBe("CALL ME  FROM IBMUSER");
	});

	it("goes to the operator without USER, and works from the console", async () => {
		const a = await Terminal.logon();
		await a.fill("option", "5.2").send("ENTER");
		await a.fill("cmd", "send 'printer jammed'").send("ENTER");
		expect(a.message).toBe("CUS1212I MESSAGE SENT TO THE OPERATOR");
		await a.send("ENTER");
		expect(a.scr.fields.some((f) => f.text?.includes("IKJ79154I PRINTER JAMMED  FROM IBMUSER"))).toBe(true);
		await a.fill("cmd", "send hello").send("ENTER");
		expect(a.message).toBe("CUS1213E ENTER SEND 'MESSAGE' USER(USERID)");
	});
});

describe("console", () => {
	it("lists TSO users and locked records", async () => {
		const b = await Terminal.as("GRSUSER", "TERM0042");
		await b.fill("option", "1.2 112").send("ENTER");
		await b.send("PF4");

		const a = await Terminal.logon();
		await a.fill("option", "5.2").send("ENTER");
		await a.fill("cmd", "d ts").send("ENTER");
		const text = a.scr.fields.map((f) => f.text ?? "").join("\n");
		expect(text).toMatch(/IEE114I .* \d+ TSO USERS/);
		expect(text).toMatch(/GRSUSER  TSU\d{5} TERM0042 CUSM02/);
		expect(text).toMatch(/IBMUSER  TSU\d{5} TERM0001 CUSO01   IDLE 00:00 \*/);

		await a.fill("cmd", "d grs").send("ENTER");
		const grs = a.scr.fields.map((f) => f.text ?? "").join("\n");
		expect(grs).toMatch(/ISG343I GRS STATUS - \d+ RECORDS? LOCKED FOR UPDATE/);
		expect(grs).toMatch(/CUSTOMER 000112 +GRSUSER  TERM0042 \d\d:\d\d:\d\d/);
	});

	it("is a live screen", async () => {
		const a = await Terminal.logon();
		a.live = true;
		await a.fill("option", "5.2").send("ENTER");
		expect((a.scr as any).live).toBe("syslog");
		expect(a.row(4)).toContain("SYSLOG - FOLLOWING, LIVE");
		await a.send("PF7");
		expect((a.scr as any).live).toBeUndefined();
	});
});

describe("GET /v1/live", () => {
	it("needs Access and a WebSocket", async () => {
		expect((await worker.fetch("https://api.test/v1/live")).status).toBe(401);
		const res = await worker.fetch("https://api.test/v1/live", { headers: { "Cf-Access-Jwt-Assertion": await accessJWT() } });
		expect(res.status).toBe(426);
	});

	it("pushes SYSLOG moving and messages", async () => {
		const l = await listen("pushme");
		const stub = tso(env);
		await runDurableObjectAlarm(stub); // the first look only notes where the log ends
		await syslog(env.DB, "TEST", "CUS9999I SOMETHING HAPPENED");
		await runDurableObjectAlarm(stub);
		expect(await l.next()).toMatchObject({ event: "syslog" });

		const a = await Terminal.logon();
		await Terminal.as("PUSHME");
		await a.fill("option", "send 'look' user(pushme)").send("ENTER");
		expect(await l.next()).toEqual({ event: "message" });
		l.ws.close();
	});
});
