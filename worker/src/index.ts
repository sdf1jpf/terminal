// Customer information API on Cloudflare Workers, backed by D1. The Go
// terminal's client for it is internal/api/client.go.
//
//	GET    /v1/health
//	POST   /v1/session              logon: -> {"userid"}
//	GET    /v1/screen/info          the logon screen's title and what the clients may use (not signed on)
//	POST   /v1/screen               the terminal's screens; see docs/screen-protocol.md
//	GET    /v1/live                 WebSocket: events that tell a terminal to redraw its screen
//	GET    /v1/customers?prefix=X   list, ordered by name; also &city=, &state=, &status=
//	POST   /v1/customers            create
//	GET    /v1/customers/{id}
//	PUT    /v1/customers/{id}       update; "version" must match
//	DELETE /v1/customers/{id}
//	GET    /v1/customers/{id}/transactions   activity, newest first
//	POST   /v1/customers/{id}/transactions   post an invoice or payment
//	GET    /v1/customers/{id}/history        change history, newest first
//	GET    /v1/search?q=X&type=T    customers, invoices, POs, shipments, vendors, products matching X
//	GET    /v1/search/natural?q=X   a search in plain English: -> {"filter", "description", "hits"}
//	POST   /v1/ask                  ask the HELP facility: {"question"} -> {"answer", "topics"}
//	GET    /v1/products?prefix=X    product file, ordered by SKU
//	GET    /v1/products?q=X         active products whose SKU or description contains X
//	POST   /v1/products             add a product
//	GET    /v1/products/{sku}
//	PUT    /v1/products/{sku}       update; "version" must match
//	GET    /v1/invoices?customer=X  invoices, newest first
//	POST   /v1/invoices             open one: {"customer_id", "po_number"}
//	GET    /v1/invoices/{id}        -> {"invoice", "lines"}
//	PUT    /v1/invoices/{id}        change the PO number or addresses: {"po_number", "bill_to", "ship_to"},
//	                                each address {"name", "address", "city", "state", "zip"}
//	DELETE /v1/invoices/{id}        cancel an open invoice, returning its stock
//	POST   /v1/invoices/{id}/lines  add a line: {"sku", "quantity"}
//	PUT    /v1/invoices/{id}/lines/{n}   change its quantity: {"quantity"}
//	DELETE /v1/invoices/{id}/lines/{n}
//	POST   /v1/invoices/{id}/bill   post the total to the customer's account
//	POST   /v1/invoices/{id}/pay    post the payment
//	GET    /v1/invoices/{id}/timeline   its lifecycle: -> {"flow", "workflow", "pending", "events"}
//	GET    /v1/edi?partner=X        EDI mailbox, newest first (without the raw X12)
//	POST   /v1/edi                  receive an X12 interchange (the body, as text)
//	GET    /v1/edi/{id}             one interchange with its raw X12
//	GET    /v1/edi/exceptions?all=1 850 lines held for correction (open ones by default)
//	POST   /v1/edi/exceptions/{n}/correct   put this product on the order instead: {"sku"}
//	POST   /v1/edi/exceptions/{n}/drop      leave the line off the order
//	POST   /v1/edi/exceptions/{n}/reject    reject the whole order, cancelling its invoice
//	GET    /v1/customers/{id}/sales   who sells to it and its pricing: -> {"assignment", "pricing"}
//	PUT    /v1/customers/{id}/sales   assign it: {"territory", "salesperson"} ("" for its state's), "tax_exempt" (a certificate, "" when taxable)
//	PUT    /v1/customers/{id}/pricing/{item}   a SKU, product line or *: {"discount"} (a percentage) or {"price"}
//	DELETE /v1/customers/{id}/pricing/{item}
//	GET    /v1/territories          sales territories, with their states
//	PUT    /v1/territories/{code}   add or change one: {"name", "salesperson", "states"}
//	DELETE /v1/territories/{code}   one with no states or customers
//	GET    /v1/salespeople
//	POST   /v1/salespeople          add one: {"name", "commission", "status"}
//	PUT    /v1/salespeople/{id}     change one: the same
//	GET    /v1/sales?by=T|S&month=YYYY-MM   billed sales by territory or salesperson, with commission
//	GET    /v1/vendors              vendors, with their open PO and product counts
//	GET    /v1/vendors/{id}
//	GET    /v1/purchase-orders?vendor=X   purchase orders, newest first
//	POST   /v1/purchase-orders      open one: {"vendor_id"}
//	GET    /v1/purchase-orders/{id} -> {"po", "lines"}
//	DELETE /v1/purchase-orders/{id} cancel an open purchase order
//	POST   /v1/purchase-orders/{id}/lines         add a line: {"sku", "quantity"}
//	DELETE /v1/purchase-orders/{id}/lines/{n}
//	POST   /v1/purchase-orders/{id}/send          send it to the vendor as an 850
//	POST   /v1/purchase-orders/{id}/receive       receive goods: {"lines": {"1": 5}}, or {} for all
//	GET    /v1/purchase-orders/{id}/timeline      its lifecycle: -> {"flow", "workflow", "pending", "events"}
//	GET    /v1/shipments?status=X   shipments, newest first (P picking, K packed, S shipped)
//	POST   /v1/shipments            release an open invoice to the warehouse: {"invoice_id"}
//	GET    /v1/shipments/{id}       -> {"shipment", "invoice", "lines"}
//	DELETE /v1/shipments/{id}       cancel one that has not shipped
//	POST   /v1/shipments/{id}/pack  {"cartons", "weight"}; the system chooses the carrier ("carrier", "route")
//	POST   /v1/shipments/{id}/ship  with the carrier chosen at packing; sends an 856 for EDI orders
//	GET    /v1/shipments/{id}/tracking   where it is: -> {"shipment", "events"} (scans, newest first)
//	POST   /v1/shipments/{id}/tracking   ask the carrier now, then the same
//	POST   /v1/shipments/{id}/delivered  sign off a company truck delivery: {"signed_by"}
//	GET    /v1/track/{number}       a shipment by its number, invoice or tracking number -> as /tracking
//	GET    /v1/trucks               the company's trucks; POST adds one
//	GET    /v1/trucks/{id}          PUT changes one ("version" must match)
//	POST   /v1/trucks/{id}/serviced record a service: the next is due 15,000 miles or 90 days on
//	GET    /v1/drivers              the company's drivers; POST adds one
//	GET    /v1/drivers/{id}         with "duty_minutes" this week; PUT changes one ("version" must match)
//	GET    /v1/loads?day=YYYY-MM-DD truck loads for a day (today by default) -> {"day", "loads", "waiting"}
//	POST   /v1/loads/plan           plan a day's loads from the truck shipments waiting: {"day"} -> {"loads", "unplanned"}
//	GET    /v1/loads/{id}           -> {"load", "stops", "truck", "driver"}
//	PUT    /v1/loads/{id}           put a planned load on another truck or driver: {"truck_id", "driver_id"}
//	DELETE /v1/loads/{id}           cancel a planned load; its shipments wait again
//	POST   /v1/loads/{id}/dispatch  send it out: its shipments ship and are out for delivery
//	POST   /v1/loads/{id}/stops/{shipment}/delivered  proof of delivery: {"signed_by", "cartons" (0: all), "note"}
//	POST   /v1/loads/{id}/stops/{shipment}/missed     not delivered: {"reason"}; it waits for another load
//	POST   /v1/loads/{id}/return    the truck is back, every stop signed off: {"miles"}, the planned miles if 0 or left out
//	GET    /v1/dispatch?day=X       the dispatch board: each load, its next stop and when it is due back
//	GET    /v1/freight/costs?month=YYYY-MM   truck loads' costs against the carriers', and what each carrier charged
//	GET    /v1/ledger?period=YYYY-MM          trial balance (the open period by default)
//	GET    /v1/ledger/periods       accounting periods, newest first
//	GET    /v1/ledger/accounts/{n}?period=X   an account's journal entries in a period
//	POST   /v1/jobs                 submit a batch job: {"name"}
//	GET    /v1/jobs                 recent jobs, newest first
//	GET    /v1/jobs/{id}            a job and its output listing
//	POST   /v1/jobs/{id}/explain    explain why it failed: -> {"explanation"}
//	GET    /v1/syslog?before=N      the system log, newest first; &limit= (max 500)
//	GET    /v1/schedules            the job schedule, with each job's next run
//	PUT    /v1/schedules/{job}      schedule a job: {"cron", "enabled"?}
//	DELETE /v1/schedules/{job}
//	GET    /v1/spool?name=X         the print spool, newest first
//	GET    /v1/spool/{id}           an output group and its lines
//	GET    /v1/spool/{id}/print     paged for the printer, as text
//	POST   /v1/spool/{id}/print     print it on PRT1 (again, for a reprint)
//	DELETE /v1/spool/{id}           purge it
//	GET    /v1/spool/{id}/pdf       printed on green-bar paper, as a PDF
//	GET    /v1/invoices/{id}/pdf    the invoice as a PDF (a pro forma while open)
//	GET    /v1/customers/{id}/statement   a statement of the last 30 days, as a PDF
//	GET    /v1/archive?name=X&kind=K      archived output and documents, newest first
//	GET    /v1/archive/{key}        one entry; {key}.pdf and {key}.txt are its files
//	POST   /v1/archive/restore      put an archived listing back on the spool: {"key"}
//	GET    /v1/mail?ref=X           the mail log, newest first: statements and letters sent, vendor mail received
//	GET    /v1/mail/{seq}
//	GET    /v1/tables               the system tables (KV), with their row counts
//	GET    /v1/tables/{t}           a table's columns and rows
//	PUT    /v1/tables/{t}/{key}     add or change a row
//	DELETE /v1/tables/{t}/{key}
//	DELETE /v1/tables/{t}           put a table back to its defaults
//	GET    /v1/monitor?minutes=N    transaction statistics (Analytics Engine)
//
// PUT and DELETE on a customer or product are refused with 423 while
// another user has it locked for update on a terminal (sessions.ts).
//
// A cron trigger runs the job scheduler every minute (scheduler.ts), and
// keeps the HELP facility's Vectorize index current (ai.ts).
//
// Routing is Hono. Everything except health is behind Cloudflare Access,
// applied per route by the signedOn middleware (auth.ts). The browser
// terminal at / is static assets (public/) and never reaches this code.
// Every request is timed and written to the transaction monitor
// (monitor.ts).

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { AiError, ask, describe, explainJob, naturalSearch } from "./ai";
import { routePath } from "hono/route";
import { customerHistory, listTransactions, parsePosting, postTransaction, transactionFields } from "./activity";
import { authenticate } from "./auth";
import { customerFields, parseEditable } from "./customer";
import {
	assign, assignment, deletePricing, deleteTerritory, listPricing, listSalespeople, listTerritories, salesBy, saveSalesperson,
	saveTerritory, setPricing, setTaxExempt,
} from "./sales";
import { createCustomer, deleteCustomer, getCustomer, listCustomers, notFound, updateCustomer } from "./data";
import { errorResponse, HttpError, int, json, noContent, readJSON, str } from "./http";
import {
	addLine, cancelInvoice, changeLine, createInvoice, deleteLine, getInvoice, listInvoices, payInvoice, setAddress, setPO,
	type Address,
} from "./invoices";
import { bill, getInterchange, listInterchanges, receive } from "./edi";
import { getJob, listJobs, startJobs, submitJob, type JobMessage } from "./jobs";
import { getFlow, pendingSignals, timeline, workflowStatus, type OrderKind, type OrderParams } from "./lifecycle";
import { correctException, dropException, listExceptions, rejectOrder } from "./ediexceptions";
import { deleteSchedule, listSchedules, putSchedule, tick } from "./scheduler";
import { getOutput, listOutput, printOutput, printText, purgeOutput } from "./spool";
import { recent } from "./syslog";
import { record, stats } from "./monitor";
import { deleteRow, listTables, putRow, readTable, resetTable, sorted, table } from "./systables";
import { filterSearch, hitTypes, search, type HitType } from "./search";
import { createProduct, getProduct, listProducts, parseProduct, productFields, searchProducts, updateProduct } from "./products";
import {
	addPOLine, cancelPO, createPO, deletePOLine, getPO, getVendor, listPOs, listVendors, receivePO, sendPO,
} from "./purchasing";
import { accountEntries, listPeriods, openPeriod, trialBalance } from "./ledger";
import { cancelShipment, getShipment, listShipments, pack, release, ship } from "./shipping";
import { confirmDelivery, findShipment, getTracking } from "./tracking";
import {
	assignLoad, board, cancelLoad, dayOf, dispatchLoad, dutyMinutes, freightDay, getDriver, getLoad, getTruck, listDrivers, listLoads, listTrucks,
	deliverStop, freightCosts, parseDriver, parseTruck, planLoads, returnLoad, saveDriver, saveTruck, stopNotDelivered, truckServiced, waitingShipments,
} from "./fleet";
import { config as screens, requestKeys, screen } from "./screens";
import { archiveFile, getEntry, listArchive, restoreArchive } from "./archive";
import { buildStatements, invoicePdf, listingPdf, statementPdf } from "./documents";
import { pdfResponse } from "./pdf";
import { getMail, listMail, receiveMail } from "./mail";
import { format, imageResponse, listingPageHtml, render, screenHtml, snapScreen } from "./snapshot";
import { notLocked, tso, USER_HEADER, type Sessions } from "./sessions";

export interface Env {
	DB: D1Database;
	ACCESS_TEAM_DOMAIN?: string; // e.g. "example.cloudflareaccess.com"
	ACCESS_AUD?: string; // the Access application's audience tag
	DEV_USER?: string; // wrangler dev only, when Access is not configured
	JOBS: Queue<JobMessage>; // the batch job input queue
	JOB_RUNNER: Workflow<JobMessage>;
	ORDER_FLOW: Workflow<OrderParams>; // one OrderLifecycle per invoice and purchase order (lifecycle.ts)
	ARCHIVE: R2Bucket; // old output and documents, as files (archive.ts)
	BROWSER?: BrowserRun; // Browser Rendering, for snapshots (snapshot.ts)
	MAIL?: SendEmail; // Email Routing, sending only to MAIL_TO (mail.ts)
	MAIL_FROM?: string; // the company's address on its domain
	MAIL_TO?: string; // the one verified address all mail goes to
	AI: Ai; // Workers AI, for the HELP facility (ai.ts)
	VECTORIZE: Vectorize; // the customer-help index: help topics and products by meaning
	TABLES: KVNamespace; // the system tables (systables.ts)
	TXN?: AnalyticsEngineDataset; // the transaction monitor (monitor.ts)
	CF_ACCOUNT_ID?: string; // for the Analytics Engine SQL API
	AE_API_TOKEN?: string; // secret: an API token with Account Analytics Read
	SESSIONS: DurableObjectNamespace<Sessions>; // the TSO address space
}

export { JobRunner } from "./jobs";
export { OrderLifecycle } from "./lifecycle";
export { Sessions } from "./sessions";

type App = { Bindings: Env; Variables: { user: string; tran?: string; terminal?: string } };

// signedOn verifies the Access JWT and sets "user" to the logged-on userid,
// or throws 401. It runs per route, so unknown paths and wrong methods get
// 404 and 405 without signing on, as before.
const signedOn: MiddlewareHandler<App> = async (c, next) => {
	c.set("user", await authenticate(c.env, c.req.raw));
	await next();
};

const app = new Hono<App>({ strict: false });

app.onError((e) => {
	if (e instanceof HttpError) return errorResponse(e);
	if (e instanceof AiError) return errorResponse(new HttpError(503, "unavailable", "help facility not available: " + e.message));
	console.error(e);
	return errorResponse(new HttpError(500, "internal", "internal error"));
});
app.notFound(() => errorResponse(new HttpError(404, "not_found", "no such endpoint")));

// Time every request for the transaction monitor. A screen request is the
// transaction of the screen it sends back; an API request is its route.
app.use("*", async (c, next) => {
	const start = Date.now();
	await next();
	const route = routePath(c);
	const tran = c.get("tran") ?? (route === "*" || route === "/*" ? "UNKNOWN" : `${c.req.method} ${route}`);
	const kind = c.get("tran") ? "SCREEN" : "API";
	record(c.env, { tran, kind, user: c.get("user") ?? "", terminal: c.get("terminal") ?? "", ms: Date.now() - start, status: c.res.status });
});

app.get("/v1/health", () => json(200, { status: "ok" }));

// The clients ask this before logon to title their logon screen and to
// know what they may use, so it is not signed on and says nothing secret.
app.get("/v1/screen/info", () => {
	const { title, system, prefix, tagline } = screens.app;
	return json(200, { v: 1, title, system, prefix, tagline, live: true, snapshot: true });
});

app.post("/v1/session", signedOn, (c) => json(201, { userid: c.get("user") }));

app.post("/v1/screen", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, requestKeys);
	c.set("terminal", typeof body.terminal === "string" ? body.terminal : "");
	const res = await screen(c.env, c.get("user"), new URL(c.req.url), body);
	c.set("tran", "screen" in res ? res.screen.map : "LOGOFF");
	return json(200, res);
});

// The terminals' push channel. The Sessions object keeps the socket and
// sends events on it; see docs/screen-protocol.md.
app.get("/v1/live", signedOn, async (c) => {
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
		throw new HttpError(426, "bad_request", "GET /v1/live is a WebSocket: send Upgrade: websocket");
	}
	const req = new Request(c.req.raw);
	req.headers.set(USER_HEADER, c.get("user"));
	return tso(c.env).fetch(req);
});

app.get("/v1/customers", signedOn, async (c) => {
	const q = (k: string) => c.req.query(k) ?? "";
	return json(200, await listCustomers(c.env.DB, q("prefix"), { city: q("city"), state: q("state"), status: q("status") }));
});
app.post("/v1/customers", signedOn, async (c) => {
	const { fields } = parseEditable(await readJSON(c.req.raw, customerFields));
	return json(201, await createCustomer(c.env.DB, fields, c.get("user")));
});
app.get("/v1/customers/:id", signedOn, async (c) => json(200, await getCustomer(c.env.DB, c.req.param("id"))));
app.put("/v1/customers/:id", signedOn, async (c) => {
	await notLocked(c.env, `CUSTOMER ${c.req.param("id")}`, c.get("user"));
	const { fields, version } = parseEditable(await readJSON(c.req.raw, customerFields));
	return json(200, await updateCustomer(c.env.DB, c.req.param("id"), fields, version, c.get("user")));
});
app.delete("/v1/customers/:id", signedOn, async (c) => {
	await notLocked(c.env, `CUSTOMER ${c.req.param("id")}`, c.get("user"));
	await deleteCustomer(c.env.DB, c.req.param("id"), c.get("user"));
	return noContent();
});
app.get("/v1/customers/:id/transactions", signedOn, async (c) => {
	const list = await listTransactions(c.env.DB, c.req.param("id"));
	if (!list) throw notFound();
	return json(200, list);
});
app.post("/v1/customers/:id/transactions", signedOn, async (c) =>
	json(201, await postTransaction(c.env.DB, c.get("user"), c.req.param("id"), parsePosting(await readJSON(c.req.raw, transactionFields)))),
);
app.get("/v1/customers/:id/statement", signedOn, async (c) => {
	const [st] = await buildStatements(c.env.DB, c.req.param("id"));
	if (!st) throw notFound();
	return pdfResponse(statementPdf(st), `STMT-${st.customer.id}-${st.asOf.slice(0, 10)}.pdf`);
});
app.get("/v1/customers/:id/history", signedOn, async (c) => json(200, await customerHistory(c.env.DB, c.req.param("id"))));

app.get("/v1/search", signedOn, async (c) => {
	const types = (c.req.query("type") ?? "").toUpperCase().split(",").filter(Boolean);
	const bad = types.find((t) => !(t in hitTypes));
	if (bad) throw new HttpError(400, "bad_request", `unknown type "${bad}": use ${Object.keys(hitTypes).join(", ")}`);
	return json(200, await search(c.env.DB, c.req.query("q") ?? "", types as HitType[]));
});

app.get("/v1/search/natural", signedOn, async (c) => {
	const q = (c.req.query("q") ?? "").trim();
	if (!q) throw new HttpError(400, "bad_request", '"q" is required');
	const { filter, also } = await naturalSearch(c.env, q);
	return json(200, { filter, description: describe(filter), hits: await filterSearch(c.env.DB, filter, also) });
});

app.post("/v1/ask", signedOn, async (c) => {
	const question = str(await readJSON(c.req.raw, ["question"]), "question").trim();
	if (!question) throw new HttpError(422, "invalid", "a question is required", "question");
	const got = await ask(c.env, question.slice(0, 500));
	if (got.error) throw new AiError(got.error);
	return json(200, { answer: got.answer, topics: got.topics.map(({ id, title, go }) => ({ id, title, go })) });
});

app.get("/v1/products", signedOn, async (c) => {
	const q = c.req.query("q");
	return json(200, q !== undefined ? await searchProducts(c.env.DB, q) : await listProducts(c.env.DB, c.req.query("prefix") ?? ""));
});
app.post("/v1/products", signedOn, async (c) => {
	const { fields } = parseProduct(await readJSON(c.req.raw, productFields));
	return json(201, await createProduct(c.env.DB, fields, c.get("user")));
});
app.get("/v1/products/:sku", signedOn, async (c) => json(200, await getProduct(c.env.DB, c.req.param("sku").toUpperCase())));
app.put("/v1/products/:sku", signedOn, async (c) => {
	const sku = c.req.param("sku").toUpperCase();
	await notLocked(c.env, `PRODUCT ${sku}`, c.get("user"));
	const { fields, version } = parseProduct({ ...(await readJSON(c.req.raw, productFields)), sku });
	return json(200, await updateProduct(c.env.DB, sku, fields, version, c.get("user")));
});

app.get("/v1/invoices", signedOn, async (c) => json(200, await listInvoices(c.env.DB, c.req.query("customer") ?? "")));
app.post("/v1/invoices", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["customer_id", "po_number"]);
	return json(201, await createInvoice(c.env.DB, c.get("user"), str(body, "customer_id"), str(body, "po_number")));
});
app.get("/v1/invoices/:id", signedOn, async (c) => json(200, await getInvoice(c.env.DB, c.req.param("id").toUpperCase())));
app.put("/v1/invoices/:id", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["po_number", "bill_to", "ship_to"]);
	const id = c.req.param("id").toUpperCase();
	const addrs = (["bill", "ship"] as const).map((kind) => [kind, address(body, `${kind}_to`)] as const);
	let inv = "po_number" in body || addrs.every(([, a]) => !a)
		? await setPO(c.env.DB, id, str(body, "po_number"))
		: (await getInvoice(c.env.DB, id)).invoice;
	for (const [kind, a] of addrs) if (a) inv = await setAddress(c.env.DB, id, kind, a);
	return json(200, inv);
});
app.delete("/v1/invoices/:id", signedOn, async (c) => {
	await cancelInvoice(c.env.DB, c.req.param("id").toUpperCase());
	return noContent();
});
app.post("/v1/invoices/:id/lines", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["sku", "quantity"]);
	return json(201, await addLine(c.env.DB, c.req.param("id").toUpperCase(), str(body, "sku"), int(body, "quantity")));
});
app.put("/v1/invoices/:id/lines/:line", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["quantity"]);
	return json(200, await changeLine(c.env.DB, c.req.param("id").toUpperCase(), lineNumber(c.req.param("line")), int(body, "quantity")));
});
app.delete("/v1/invoices/:id/lines/:line", signedOn, async (c) => {
	await deleteLine(c.env.DB, c.req.param("id").toUpperCase(), lineNumber(c.req.param("line")));
	return noContent();
});
app.get("/v1/invoices/:id/pdf", signedOn, async (c) => {
	const { invoice, lines } = await getInvoice(c.env.DB, c.req.param("id").toUpperCase());
	return pdfResponse(invoicePdf(invoice, lines, await getCustomer(c.env.DB, invoice.customer_id)), `${invoice.id}.pdf`);
});
app.post("/v1/invoices/:id/bill", signedOn, async (c) => json(200, await bill(c.env.DB, c.env.TABLES, c.get("user"), c.req.param("id").toUpperCase())));
app.post("/v1/invoices/:id/pay", signedOn, async (c) => json(200, await payInvoice(c.env.DB, c.get("user"), c.req.param("id").toUpperCase())));
// orderTimeline is an order's lifecycle: its flow, workflow status,
// undelivered changes and timeline.
async function orderTimeline(env: Env, kind: OrderKind, id: string) {
	const [flow, events, pending, workflow] = await Promise.all([
		getFlow(env.DB, kind, id), timeline(env.DB, kind, id), pendingSignals(env.DB, kind, id), workflowStatus(env, kind, id),
	]);
	const table = kind === "I" ? "invoices" : "purchase_orders";
	if (!flow && events.length === 0 && !(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(id).first())) {
		throw new HttpError(404, "not_found", kind === "I" ? "invoice not found" : "purchase order not found");
	}
	return json(200, { flow: flow ?? null, workflow, pending, events });
}
app.get("/v1/invoices/:id/timeline", signedOn, (c) => orderTimeline(c.env, "I", c.req.param("id").toUpperCase()));
app.get("/v1/purchase-orders/:id/timeline", signedOn, (c) => orderTimeline(c.env, "P", c.req.param("id").toUpperCase()));

// address reads an optional address object from a request body.
function address(body: Record<string, unknown>, key: string): Address | undefined {
	const v = body[key];
	if (v === undefined) return undefined;
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		throw new HttpError(400, "bad_request", `invalid request body: "${key}" must be an object`);
	}
	const a = v as Record<string, unknown>;
	for (const k of Object.keys(a)) {
		if (!["name", "address", "city", "state", "zip"].includes(k)) {
			throw new HttpError(400, "bad_request", `invalid request body: unknown field "${key}.${k}"`);
		}
	}
	return { name: str(a, "name"), address: str(a, "address"), city: str(a, "city"), state: str(a, "state"), zip: str(a, "zip") };
}

function lineNumber(s: string): number {
	if (!/^\d{1,5}$/.test(s)) throw new HttpError(404, "not_found", "invoice line not found");
	return Number(s);
}

app.get("/v1/edi", signedOn, async (c) => json(200, await listInterchanges(c.env.DB, c.req.query("partner") ?? "")));
app.post("/v1/edi", signedOn, async (c) => {
	const filed = await receive(c.env.DB, c.get("user"), await c.req.text());
	await c.env.JOBS.send({ id: filed.id, kind: "edi" } satisfies JobMessage);
	return json(202, filed);
});
app.get("/v1/edi/exceptions", signedOn, async (c) => json(200, await listExceptions(c.env.DB, c.req.query("all") === "1")));
const exceptionSeq = (c: { req: { param: (k: string) => string } }) => {
	const n = Number(c.req.param("seq"));
	if (!Number.isInteger(n) || n < 1) throw new HttpError(404, "not_found", "EDI exception not found");
	return n;
};
app.post("/v1/edi/exceptions/:seq/correct", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["sku"]);
	return json(200, await correctException(c.env.DB, c.get("user"), exceptionSeq(c), str(body, "sku")));
});
app.post("/v1/edi/exceptions/:seq/drop", signedOn, async (c) => json(200, await dropException(c.env.DB, c.get("user"), exceptionSeq(c))));
app.post("/v1/edi/exceptions/:seq/reject", signedOn, async (c) => json(200, await rejectOrder(c.env.DB, c.get("user"), exceptionSeq(c))));
app.get("/v1/edi/:id", signedOn, async (c) => json(200, await getInterchange(c.env.DB, c.req.param("id"))));

app.get("/v1/customers/:id/sales", signedOn, async (c) => {
	const id = c.req.param("id");
	return json(200, { assignment: await assignment(c.env.DB, id), pricing: await listPricing(c.env.DB, id) });
});
app.put("/v1/customers/:id/sales", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["territory", "salesperson", "tax_exempt"]);
	const id = c.req.param("id");
	if (body.tax_exempt !== undefined) await setTaxExempt(c.env.DB, c.get("user"), id, str(body, "tax_exempt"));
	if (body.territory === undefined && body.salesperson === undefined) return json(200, await assignment(c.env.DB, id));
	return json(200, await assign(c.env.DB, c.get("user"), id, { territory: str(body, "territory"), salesperson: str(body, "salesperson") }));
});
app.put("/v1/customers/:id/pricing/:item", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["discount", "price"]);
	// Either may be a number or a string such as "12.5".
	const text = (k: string) => (body[k] === undefined || body[k] === null ? "" : String(body[k]));
	return json(200, await setPricing(c.env.DB, c.get("user"), c.req.param("id"), { item: c.req.param("item"), disc: text("discount"), price: text("price") }));
});
app.delete("/v1/customers/:id/pricing/:item", signedOn, async (c) => {
	await deletePricing(c.env.DB, c.get("user"), c.req.param("id"), c.req.param("item").toUpperCase());
	return noContent();
});
app.get("/v1/territories", signedOn, async (c) => json(200, await listTerritories(c.env.DB)));
app.put("/v1/territories/:code", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["name", "salesperson", "states"]);
	return json(200, await saveTerritory(c.env.DB, c.get("user"), {
		code: c.req.param("code"), name: str(body, "name"), salesperson: str(body, "salesperson"), states: str(body, "states"),
	}));
});
app.delete("/v1/territories/:code", signedOn, async (c) => {
	await deleteTerritory(c.env.DB, c.req.param("code").toUpperCase());
	return noContent();
});
app.get("/v1/salespeople", signedOn, async (c) => json(200, await listSalespeople(c.env.DB)));
const salesperson = async (c: Context<App>, id: string) => {
	const body = await readJSON(c.req.raw, ["name", "commission", "status"]);
	const r = await saveSalesperson(c.env.DB, c.get("user"), id, { name: str(body, "name"), comm: str(body, "commission"), status: str(body, "status") });
	return json(id ? 200 : 201, r);
};
app.post("/v1/salespeople", signedOn, (c) => salesperson(c, ""));
app.put("/v1/salespeople/:id", signedOn, (c) => salesperson(c, c.req.param("id").toUpperCase()));
app.get("/v1/sales", signedOn, async (c) => {
	const by = (c.req.query("by") ?? "T").toUpperCase();
	if (by !== "T" && by !== "S") throw new HttpError(400, "bad_request", 'by must be T (territory) or S (salesperson)');
	const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "bad_request", "month must be YYYY-MM");
	return json(200, await salesBy(c.env.DB, by, month));
});

app.get("/v1/vendors", signedOn, async (c) => json(200, await listVendors(c.env.DB)));
app.get("/v1/vendors/:id", signedOn, async (c) => json(200, await getVendor(c.env.DB, c.req.param("id"))));

app.get("/v1/purchase-orders", signedOn, async (c) => json(200, await listPOs(c.env.DB, c.req.query("vendor") ?? "")));
app.post("/v1/purchase-orders", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["vendor_id"]);
	return json(201, await createPO(c.env.DB, c.get("user"), str(body, "vendor_id")));
});
app.get("/v1/purchase-orders/:id", signedOn, async (c) => json(200, await getPO(c.env.DB, c.req.param("id").toUpperCase())));
app.delete("/v1/purchase-orders/:id", signedOn, async (c) => {
	await cancelPO(c.env.DB, c.req.param("id").toUpperCase());
	return noContent();
});
app.post("/v1/purchase-orders/:id/lines", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["sku", "quantity"]);
	return json(201, await addPOLine(c.env.DB, c.req.param("id").toUpperCase(), str(body, "sku"), int(body, "quantity")));
});
app.delete("/v1/purchase-orders/:id/lines/:line", signedOn, async (c) => {
	await deletePOLine(c.env.DB, c.req.param("id").toUpperCase(), lineNumber(c.req.param("line")));
	return noContent();
});
app.post("/v1/purchase-orders/:id/send", signedOn, async (c) => json(200, await sendPO(c.env.DB, c.req.param("id").toUpperCase())));
app.post("/v1/purchase-orders/:id/receive", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["lines"]);
	let qty: Map<number, number> | "all" = "all";
	if (body.lines !== undefined) {
		const lines = body.lines;
		if (typeof lines !== "object" || lines === null || Array.isArray(lines)) {
			throw new HttpError(400, "bad_request", 'invalid request body: "lines" must be an object of line numbers and quantities');
		}
		qty = new Map(Object.keys(lines).map((k) => [lineNumber(k), int(lines as Record<string, unknown>, k)]));
	}
	return json(200, await receivePO(c.env.DB, c.get("user"), c.req.param("id").toUpperCase(), qty));
});

app.get("/v1/shipments", signedOn, async (c) => json(200, await listShipments(c.env.DB, c.req.query("status") ?? "")));
app.post("/v1/shipments", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["invoice_id"]);
	return json(201, await release(c.env.DB, c.get("user"), str(body, "invoice_id").trim().toUpperCase()));
});
app.get("/v1/shipments/:id", signedOn, async (c) => json(200, await getShipment(c.env.DB, c.req.param("id"))));
app.delete("/v1/shipments/:id", signedOn, async (c) => {
	await cancelShipment(c.env.DB, c.req.param("id").toUpperCase());
	return noContent();
});
app.post("/v1/shipments/:id/pack", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["cartons", "weight"]);
	return json(200, await pack(c.env.DB, c.env.TABLES, c.req.param("id").toUpperCase(), int(body, "cartons"), int(body, "weight")));
});
app.post("/v1/shipments/:id/ship", signedOn, async (c) => {
	return json(200, await ship(c.env.DB, c.get("user"), c.req.param("id").toUpperCase()));
});
app.get("/v1/shipments/:id/tracking", signedOn, async (c) => json(200, await getTracking(c.env.DB, c.env.TABLES, c.req.param("id"))));
app.post("/v1/shipments/:id/tracking", signedOn, async (c) => json(200, await getTracking(c.env.DB, c.env.TABLES, c.req.param("id"), true)));
app.post("/v1/shipments/:id/delivered", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["signed_by"]);
	return json(200, await confirmDelivery(c.env.DB, c.get("user"), c.req.param("id"), str(body, "signed_by")));
});
app.get("/v1/track/:number", signedOn, async (c) => {
	const shp = await findShipment(c.env.DB, c.req.param("number"));
	if (!shp) throw new HttpError(404, "not_found", "no shipment has that number");
	return json(200, await getTracking(c.env.DB, c.env.TABLES, shp.id));
});

const truckKeys = ["id", "name", "plate", "capacity_lb", "cdl_class", "odometer", "status", "service_miles", "service_due", "cost_per_mile", "version"];
const driverKeys = ["id", "name", "phone", "cdl_class", "cdl_expires", "status", "hourly_rate", "version"];
const versionOf = (body: Record<string, unknown>) => {
	const v = int(body, "version");
	if (v < 1) throw new HttpError(422, "invalid", "send the version read", "version");
	return v;
};
app.get("/v1/trucks", signedOn, async (c) => json(200, await listTrucks(c.env.DB)));
app.post("/v1/trucks", signedOn, async (c) => json(201, await saveTruck(c.env.DB, c.get("user"), parseTruck(await readJSON(c.req.raw, truckKeys)), 0)));
app.get("/v1/trucks/:id", signedOn, async (c) => json(200, await getTruck(c.env.DB, c.req.param("id"))));
app.put("/v1/trucks/:id", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, truckKeys);
	return json(200, await saveTruck(c.env.DB, c.get("user"), parseTruck({ ...body, id: c.req.param("id") }), versionOf(body)));
});
app.post("/v1/trucks/:id/serviced", signedOn, async (c) => json(200, await truckServiced(c.env.DB, c.get("user"), c.req.param("id"))));
app.get("/v1/drivers", signedOn, async (c) => json(200, await listDrivers(c.env.DB)));
app.post("/v1/drivers", signedOn, async (c) => json(201, await saveDriver(c.env.DB, c.get("user"), parseDriver(await readJSON(c.req.raw, driverKeys)), 0)));
app.get("/v1/drivers/:id", signedOn, async (c) => {
	const d = await getDriver(c.env.DB, c.req.param("id"));
	return json(200, { ...d, duty_minutes: await dutyMinutes(c.env.DB, d.id, freightDay()) });
});
app.put("/v1/drivers/:id", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, driverKeys);
	return json(200, await saveDriver(c.env.DB, c.get("user"), parseDriver({ ...body, id: c.req.param("id") }), versionOf(body)));
});
app.get("/v1/loads", signedOn, async (c) => {
	const day = dayOf(c.req.query("day") ?? "");
	return json(200, { day, loads: await listLoads(c.env.DB, day), waiting: await waitingShipments(c.env.DB) });
});
app.post("/v1/loads/plan", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["day"]);
	return json(200, await planLoads(c.env.DB, c.get("user"), dayOf(str(body, "day"))));
});
app.get("/v1/loads/:id", signedOn, async (c) => json(200, await getLoad(c.env.DB, c.req.param("id"))));
app.put("/v1/loads/:id", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["truck_id", "driver_id"]);
	return json(200, await assignLoad(c.env.DB, c.get("user"), c.req.param("id"), str(body, "truck_id"), str(body, "driver_id")));
});
app.delete("/v1/loads/:id", signedOn, async (c) => {
	await cancelLoad(c.env.DB, c.get("user"), c.req.param("id"));
	return noContent();
});
app.post("/v1/loads/:id/dispatch", signedOn, async (c) => json(200, await dispatchLoad(c.env.DB, c.env.TABLES, c.get("user"), c.req.param("id"))));
app.post("/v1/loads/:id/stops/:shipment/delivered", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["signed_by", "cartons", "note"]);
	return json(200, await deliverStop(c.env.DB, c.get("user"), c.req.param("id"), c.req.param("shipment"), str(body, "signed_by"), int(body, "cartons"), str(body, "note")));
});
app.post("/v1/loads/:id/stops/:shipment/missed", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["reason"]);
	return json(200, await stopNotDelivered(c.env.DB, c.get("user"), c.req.param("id"), c.req.param("shipment"), str(body, "reason")));
});
app.post("/v1/loads/:id/return", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["miles"]);
	return json(200, await returnLoad(c.env.DB, c.env.TABLES, c.get("user"), c.req.param("id"), int(body, "miles")));
});
app.get("/v1/freight/costs", signedOn, async (c) => json(200, await freightCosts(c.env.DB, c.req.query("month") ?? freightDay().slice(0, 7))));
app.get("/v1/dispatch", signedOn, async (c) => {
	const day = dayOf(c.req.query("day") ?? "");
	return json(200, { day, board: await board(c.env.DB, day) });
});

app.get("/v1/ledger", signedOn, async (c) => json(200, await trialBalance(c.env.DB, c.req.query("period") ?? "")));
app.get("/v1/ledger/periods", signedOn, async (c) => json(200, await listPeriods(c.env.DB)));
app.get("/v1/ledger/accounts/:account", signedOn, async (c) => {
	const period = c.req.query("period") || (await openPeriod(c.env.DB)).period;
	return json(200, await accountEntries(c.env.DB, c.req.param("account"), period));
});

app.get("/v1/jobs", signedOn, async (c) => json(200, await listJobs(c.env.DB)));
app.post("/v1/jobs", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["name"]);
	return json(202, await submitJob(c.env.DB, c.env.JOBS, c.get("user"), str(body, "name")));
});
app.get("/v1/jobs/:id", signedOn, async (c) => {
	const job = await getJob(c.env.DB, c.req.param("id"));
	if (!job) throw notFound();
	return json(200, job);
});

app.post("/v1/jobs/:id/explain", signedOn, async (c) => {
	const found = await getJob(c.env.DB, c.req.param("id").toUpperCase());
	if (!found) throw notFound();
	if (found.job.status !== "OUTPUT") throw new HttpError(409, "conflict", `job ${found.job.id} has not ended`);
	return json(200, { explanation: await explainJob(c.env, found.job, found.output) });
});

app.get("/v1/syslog", signedOn, async (c) => {
	const n = (k: string) => Math.trunc(Number(c.req.query(k) ?? "")) || 0;
	return json(200, await recent(c.env.DB, n("before"), Math.min(Math.max(n("limit") || 100, 1), 500)));
});

app.get("/v1/schedules", signedOn, async (c) => json(200, await listSchedules(c.env.DB)));
app.put("/v1/schedules/:name", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["cron", "enabled"]);
	if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
		throw new HttpError(400, "bad_request", 'invalid request body: "enabled" must be a boolean');
	}
	return json(200, await putSchedule(c.env.DB, c.get("user"), c.req.param("name"), str(body, "cron"), body.enabled as boolean | undefined));
});
app.delete("/v1/schedules/:name", signedOn, async (c) => {
	await deleteSchedule(c.env.DB, c.get("user"), c.req.param("name"));
	return noContent();
});

app.get("/v1/spool", signedOn, async (c) => json(200, await listOutput(c.env.DB, c.req.query("name") ?? "")));
app.get("/v1/spool/:id", signedOn, async (c) => json(200, await getOutput(c.env.DB, c.req.param("id").toUpperCase())));
app.get("/v1/spool/:id/print", signedOn, async (c) => {
	const { output, lines } = await getOutput(c.env.DB, c.req.param("id").toUpperCase());
	return new Response(printText(output, lines), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
});
app.post("/v1/spool/:id/print", signedOn, async (c) => json(200, await printOutput(c.env.DB, c.get("user"), c.req.param("id").toUpperCase())));
app.get("/v1/spool/:id/pdf", signedOn, async (c) => {
	const { output, lines } = await getOutput(c.env.DB, c.req.param("id").toUpperCase());
	return pdfResponse(listingPdf(output, lines), `${output.id}.pdf`);
});
// A page of the output as a picture of green-bar paper.
app.get("/v1/spool/:id/png", signedOn, async (c) => {
	const { output, lines } = await getOutput(c.env.DB, c.req.param("id").toUpperCase());
	const n = Number(c.req.query("page") ?? "1");
	if (!Number.isInteger(n)) throw new HttpError(400, "invalid", '"page" must be a page number', "page");
	const p = listingPageHtml(output, lines, n);
	const res = imageResponse(await render(c.env.BROWSER, p, "png"), "png", `${output.id}-P${n}.png`);
	res.headers.set("X-Pages", String(p.pages));
	return res;
});
app.delete("/v1/spool/:id", signedOn, async (c) => {
	await purgeOutput(c.env.DB, c.get("user"), c.req.param("id").toUpperCase());
	return noContent();
});

// A picture of a screen as the terminal shows it (snapshot.ts).
app.post("/v1/snapshot", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["format", "screen", "terminal", "map"]);
	const f = format(body.format);
	const scr = snapScreen(body.screen);
	const now = new Date().toISOString().slice(0, 16).replace("T", " ");
	const map = str(body, "map").replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 8) || "SCREEN";
	const caption = `SNAPSHOT ${map}  ${c.get("user")}  ${str(body, "terminal").slice(0, 8)}  ${now} UTC`.replace(/ {3,}/g, "  ");
	const stamp = now.replace(/[-: ]/g, "").slice(0, 12);
	return imageResponse(await render(c.env.BROWSER, screenHtml(scr, caption), f), f, `${map}-${stamp}.${f}`);
});

app.get("/v1/mail", signedOn, async (c) => json(200, await listMail(c.env.DB, c.req.query("ref") ?? "")));
app.get("/v1/mail/:seq{[0-9]+}", signedOn, async (c) => json(200, await getMail(c.env.DB, Number(c.req.param("seq")))));
app.get("/v1/archive", signedOn, async (c) => json(200, await listArchive(c.env.DB, c.req.query("name") ?? "", c.req.query("kind") ?? "")));
app.post("/v1/archive/restore", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["key"]);
	return json(200, await restoreArchive(c.env.DB, c.env.ARCHIVE, c.get("user"), str(body, "key")));
});
app.get("/v1/archive/:key{.+}", signedOn, async (c) => {
	const key = c.req.param("key");
	const file = /^(.+)\.(pdf|txt)$/.exec(key);
	if (!file) return json(200, await getEntry(c.env.DB, key));
	const obj = await archiveFile(c.env.ARCHIVE, file[1], file[2] as "pdf" | "txt");
	const name = file[1].split("/").pop()!;
	return new Response(obj.body, {
		headers: {
			"Content-Type": file[2] === "pdf" ? "application/pdf" : "text/plain; charset=utf-8",
			"Content-Disposition": `inline; filename="${name}.${file[2]}"`,
		},
	});
});

app.get("/v1/tables", signedOn, async (c) => json(200, await listTables(c.env.TABLES)));
app.get("/v1/tables/:table", signedOn, async (c) => {
	const name = c.req.param("table").toUpperCase();
	const t = table(name);
	const { rows, custom } = await readTable(c.env.TABLES, name);
	const columns = t.columns.map(({ name, label, kind, len, lines, min, max }) => ({ name, label, kind, len, lines, min, max }));
	return json(200, { name, title: t.title, key: t.key.label, columns, custom, rows: sorted(rows) });
});
app.put("/v1/tables/:table/:key", signedOn, async (c) => {
	const t = table(c.req.param("table"));
	const body = await readJSON(c.req.raw, t.columns.map((col) => col.name));
	return json(200, await putRow(c.env.TABLES, c.env.DB, c.get("user"), c.req.param("table"), c.req.param("key"), body));
});
app.delete("/v1/tables/:table/:key", signedOn, async (c) => {
	await deleteRow(c.env.TABLES, c.env.DB, c.get("user"), c.req.param("table"), c.req.param("key"));
	return noContent();
});
app.delete("/v1/tables/:table", signedOn, async (c) => {
	await resetTable(c.env.TABLES, c.env.DB, c.get("user"), c.req.param("table"));
	return noContent();
});

app.get("/v1/monitor", signedOn, async (c) => json(200, await stats(c.env, Number(c.req.query("minutes") ?? 15))));

// A known path with a method it does not take is 405, not 404. Registered
// after the real routes, so it only runs when none of them matched.
for (const path of [
	"/v1/health",
	"/v1/session",
	"/v1/screen",
	"/v1/screen/info",
	"/v1/live",
	"/v1/customers",
	"/v1/customers/:id",
	"/v1/customers/:id/transactions",
	"/v1/customers/:id/history",
	"/v1/search",
	"/v1/search/natural",
	"/v1/ask",
	"/v1/products",
	"/v1/products/:sku",
	"/v1/invoices",
	"/v1/invoices/:id",
	"/v1/invoices/:id/lines",
	"/v1/invoices/:id/lines/:line",
	"/v1/invoices/:id/bill",
	"/v1/invoices/:id/pay",
	"/v1/invoices/:id/timeline",
	"/v1/edi",
	"/v1/edi/exceptions",
	"/v1/edi/exceptions/:seq/correct",
	"/v1/edi/exceptions/:seq/drop",
	"/v1/edi/exceptions/:seq/reject",
	"/v1/edi/:id",
	"/v1/vendors",
	"/v1/vendors/:id",
	"/v1/purchase-orders",
	"/v1/purchase-orders/:id",
	"/v1/purchase-orders/:id/lines",
	"/v1/purchase-orders/:id/lines/:line",
	"/v1/purchase-orders/:id/send",
	"/v1/purchase-orders/:id/receive",
	"/v1/purchase-orders/:id/timeline",
	"/v1/shipments",
	"/v1/shipments/:id",
	"/v1/shipments/:id/pack",
	"/v1/shipments/:id/ship",
	"/v1/shipments/:id/tracking",
	"/v1/shipments/:id/delivered",
	"/v1/track/:number",
	"/v1/trucks",
	"/v1/trucks/:id",
	"/v1/trucks/:id/serviced",
	"/v1/drivers",
	"/v1/drivers/:id",
	"/v1/loads",
	"/v1/loads/plan",
	"/v1/loads/:id",
	"/v1/loads/:id/dispatch",
	"/v1/loads/:id/return",
	"/v1/loads/:id/stops/:shipment/delivered",
	"/v1/loads/:id/stops/:shipment/missed",
	"/v1/dispatch",
	"/v1/freight/costs",
	"/v1/ledger",
	"/v1/ledger/periods",
	"/v1/ledger/accounts/:account",
	"/v1/jobs",
	"/v1/jobs/:id",
	"/v1/jobs/:id/explain",
	"/v1/syslog",
	"/v1/schedules",
	"/v1/schedules/:name",
	"/v1/spool",
	"/v1/spool/:id",
	"/v1/spool/:id/print",
	"/v1/spool/:id/pdf",
	"/v1/spool/:id/png",
	"/v1/snapshot",
	"/v1/invoices/:id/pdf",
	"/v1/customers/:id/statement",
	"/v1/archive",
	"/v1/archive/restore",
	"/v1/archive/:key{.+}",
	"/v1/mail",
	"/v1/mail/:seq",
	"/v1/tables",
	"/v1/tables/:table",
	"/v1/tables/:table/:key",
	"/v1/monitor",
	"/v1/customers/:id/sales",
	"/v1/customers/:id/pricing/:item",
	"/v1/territories",
	"/v1/territories/:code",
	"/v1/salespeople",
	"/v1/salespeople/:id",
	"/v1/sales",
]) {
	app.all(path, (c) => {
		throw new HttpError(405, "method_not_allowed", `${c.req.method} is not allowed on ${c.req.path.replace(/\/+$/, "")}`);
	});
}

// The queue consumer, the cron trigger, the email handler and the
// JobRunner and OrderLifecycle workflows stay outside Hono.
export default {
	fetch: app.fetch,
	queue: startJobs,
	scheduled: async (controller, env) => tick(env, new Date(controller.scheduledTime)),
	// Mail routed to the Worker by Email Routing: vendor correspondence.
	email: async (message, env) => void (await receiveMail(env, message)),
} satisfies ExportedHandler<Env, JobMessage>;
