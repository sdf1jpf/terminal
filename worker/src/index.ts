// Customer information API on Cloudflare Workers, backed by D1. The Go
// terminal's client for it is internal/api/client.go.
//
//	GET    /v1/health
//	POST   /v1/session              logon: -> {"userid"}
//	POST   /v1/screen               the terminal's screens; see docs/screen-protocol.md
//	GET    /v1/customers?prefix=X   list, ordered by name; also &city=, &state=, &status=
//	POST   /v1/customers            create
//	GET    /v1/customers/{id}
//	PUT    /v1/customers/{id}       update; "version" must match
//	DELETE /v1/customers/{id}
//	GET    /v1/customers/{id}/transactions   activity, newest first
//	POST   /v1/customers/{id}/transactions   post an invoice or payment
//	GET    /v1/customers/{id}/history        change history, newest first
//	GET    /v1/products?prefix=X    product file, ordered by SKU
//	GET    /v1/products?q=X         active products whose SKU or description contains X
//	POST   /v1/products             add a product
//	GET    /v1/products/{sku}
//	PUT    /v1/products/{sku}       update; "version" must match
//	GET    /v1/invoices?customer=X  invoices, newest first
//	POST   /v1/invoices             open one: {"customer_id", "po_number"}
//	GET    /v1/invoices/{id}        -> {"invoice", "lines"}
//	PUT    /v1/invoices/{id}        change the PO number: {"po_number"}
//	DELETE /v1/invoices/{id}        cancel an open invoice, returning its stock
//	POST   /v1/invoices/{id}/lines  add a line: {"sku", "quantity"}
//	PUT    /v1/invoices/{id}/lines/{n}   change its quantity: {"quantity"}
//	DELETE /v1/invoices/{id}/lines/{n}
//	POST   /v1/invoices/{id}/bill   post the total to the customer's account
//	POST   /v1/invoices/{id}/pay    post the payment
//	GET    /v1/edi?partner=X        EDI mailbox, newest first (without the raw X12)
//	POST   /v1/edi                  receive an X12 interchange (the body, as text)
//	GET    /v1/edi/{id}             one interchange with its raw X12
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
//	GET    /v1/shipments?status=X   shipments, newest first (P picking, K packed, S shipped)
//	POST   /v1/shipments            release an open invoice to the warehouse: {"invoice_id"}
//	GET    /v1/shipments/{id}       -> {"shipment", "invoice", "lines"}
//	DELETE /v1/shipments/{id}       cancel one that has not shipped
//	POST   /v1/shipments/{id}/pack  {"cartons", "weight"}
//	POST   /v1/shipments/{id}/ship  {"carrier"}: UPS, FDX or TRK; sends an 856 for EDI orders
//	GET    /v1/ledger?period=YYYY-MM          trial balance (the open period by default)
//	GET    /v1/ledger/periods       accounting periods, newest first
//	GET    /v1/ledger/accounts/{n}?period=X   an account's journal entries in a period
//	POST   /v1/jobs                 submit a batch job: {"name"}
//	GET    /v1/jobs                 recent jobs, newest first
//	GET    /v1/jobs/{id}            a job and its output listing
//	GET    /v1/syslog?before=N      the system log, newest first; &limit= (max 500)
//	GET    /v1/schedules            the job schedule, with each job's next run
//	PUT    /v1/schedules/{job}      schedule a job: {"cron", "enabled"?}
//	DELETE /v1/schedules/{job}
//	GET    /v1/spool?name=X         the print spool, newest first
//	GET    /v1/spool/{id}           an output group and its lines
//	GET    /v1/spool/{id}/print     paged for the printer, as text
//	POST   /v1/spool/{id}/print     print it on PRT1 (again, for a reprint)
//	DELETE /v1/spool/{id}           purge it
//
// A cron trigger runs the job scheduler every minute (scheduler.ts).
//
// Routing is Hono. Everything except health is behind Cloudflare Access,
// applied per route by the signedOn middleware (auth.ts). The browser
// terminal at / is static assets (public/) and never reaches this code.

import { Hono, type MiddlewareHandler } from "hono";
import { customerHistory, listTransactions, parsePosting, postTransaction, transactionFields } from "./activity";
import { authenticate } from "./auth";
import { customerFields, parseEditable } from "./customer";
import { createCustomer, deleteCustomer, getCustomer, listCustomers, notFound, updateCustomer } from "./data";
import { errorResponse, HttpError, int, json, noContent, readJSON, str } from "./http";
import {
	addLine, cancelInvoice, changeLine, createInvoice, deleteLine, getInvoice, listInvoices, payInvoice, setPO,
} from "./invoices";
import { bill, getInterchange, listInterchanges, receive } from "./edi";
import { getJob, listJobs, startJobs, submitJob, type JobMessage } from "./jobs";
import { deleteSchedule, listSchedules, putSchedule, tick } from "./scheduler";
import { getOutput, listOutput, printOutput, printText, purgeOutput } from "./spool";
import { recent } from "./syslog";
import { createProduct, getProduct, listProducts, parseProduct, productFields, searchProducts, updateProduct } from "./products";
import {
	addPOLine, cancelPO, createPO, deletePOLine, getPO, getVendor, listPOs, listVendors, receivePO, sendPO,
} from "./purchasing";
import { accountEntries, listPeriods, openPeriod, trialBalance } from "./ledger";
import { cancelShipment, getShipment, listShipments, pack, release, ship } from "./shipping";
import { requestKeys, screen } from "./screens";

export interface Env {
	DB: D1Database;
	ACCESS_TEAM_DOMAIN?: string; // e.g. "example.cloudflareaccess.com"
	ACCESS_AUD?: string; // the Access application's audience tag
	DEV_USER?: string; // wrangler dev only, when Access is not configured
	JOBS: Queue<JobMessage>; // the batch job input queue
	JOB_RUNNER: Workflow<JobMessage>;
}

export { JobRunner } from "./jobs";

type App = { Bindings: Env; Variables: { user: string } };

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
	console.error(e);
	return errorResponse(new HttpError(500, "internal", "internal error"));
});
app.notFound(() => errorResponse(new HttpError(404, "not_found", "no such endpoint")));

app.get("/v1/health", () => json(200, { status: "ok" }));

app.post("/v1/session", signedOn, (c) => json(201, { userid: c.get("user") }));

app.post("/v1/screen", signedOn, async (c) =>
	json(200, await screen(c.env, c.get("user"), new URL(c.req.url), await readJSON(c.req.raw, requestKeys))),
);

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
	const { fields, version } = parseEditable(await readJSON(c.req.raw, customerFields));
	return json(200, await updateCustomer(c.env.DB, c.req.param("id"), fields, version, c.get("user")));
});
app.delete("/v1/customers/:id", signedOn, async (c) => {
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
app.get("/v1/customers/:id/history", signedOn, async (c) => json(200, await customerHistory(c.env.DB, c.req.param("id"))));

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
	const body = await readJSON(c.req.raw, ["po_number"]);
	return json(200, await setPO(c.env.DB, c.req.param("id").toUpperCase(), str(body, "po_number")));
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
app.post("/v1/invoices/:id/bill", signedOn, async (c) => json(200, await bill(c.env.DB, c.get("user"), c.req.param("id").toUpperCase())));
app.post("/v1/invoices/:id/pay", signedOn, async (c) => json(200, await payInvoice(c.env.DB, c.get("user"), c.req.param("id").toUpperCase())));

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
app.get("/v1/edi/:id", signedOn, async (c) => json(200, await getInterchange(c.env.DB, c.req.param("id"))));

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
	return json(200, await pack(c.env.DB, c.req.param("id").toUpperCase(), int(body, "cartons"), int(body, "weight")));
});
app.post("/v1/shipments/:id/ship", signedOn, async (c) => {
	const body = await readJSON(c.req.raw, ["carrier"]);
	return json(200, await ship(c.env.DB, c.get("user"), c.req.param("id").toUpperCase(), str(body, "carrier")));
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
app.delete("/v1/spool/:id", signedOn, async (c) => {
	await purgeOutput(c.env.DB, c.get("user"), c.req.param("id").toUpperCase());
	return noContent();
});

// A known path with a method it does not take is 405, not 404. Registered
// after the real routes, so it only runs when none of them matched.
for (const path of [
	"/v1/health",
	"/v1/session",
	"/v1/screen",
	"/v1/customers",
	"/v1/customers/:id",
	"/v1/customers/:id/transactions",
	"/v1/customers/:id/history",
	"/v1/products",
	"/v1/products/:sku",
	"/v1/invoices",
	"/v1/invoices/:id",
	"/v1/invoices/:id/lines",
	"/v1/invoices/:id/lines/:line",
	"/v1/invoices/:id/bill",
	"/v1/invoices/:id/pay",
	"/v1/edi",
	"/v1/edi/:id",
	"/v1/vendors",
	"/v1/vendors/:id",
	"/v1/purchase-orders",
	"/v1/purchase-orders/:id",
	"/v1/purchase-orders/:id/lines",
	"/v1/purchase-orders/:id/lines/:line",
	"/v1/purchase-orders/:id/send",
	"/v1/purchase-orders/:id/receive",
	"/v1/shipments",
	"/v1/shipments/:id",
	"/v1/shipments/:id/pack",
	"/v1/shipments/:id/ship",
	"/v1/ledger",
	"/v1/ledger/periods",
	"/v1/ledger/accounts/:account",
	"/v1/jobs",
	"/v1/jobs/:id",
	"/v1/syslog",
	"/v1/schedules",
	"/v1/schedules/:name",
	"/v1/spool",
	"/v1/spool/:id",
	"/v1/spool/:id/print",
]) {
	app.all(path, (c) => {
		throw new HttpError(405, "method_not_allowed", `${c.req.method} is not allowed on ${c.req.path.replace(/\/+$/, "")}`);
	});
}

// The queue consumer, the cron trigger and the JobRunner workflow stay
// outside Hono.
export default {
	fetch: app.fetch,
	queue: startJobs,
	scheduled: async (controller, env) => tick(env, new Date(controller.scheduledTime)),
} satisfies ExportedHandler<Env, JobMessage>;
