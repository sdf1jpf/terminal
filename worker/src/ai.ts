// The HELP facility, on Workers AI and Vectorize. It answers questions
// about the system in plain English (HELP how do I put a customer on
// hold), explains why a batch job failed, and turns a plain-English search
// (FIND customers in Ohio over their credit limit) into a query.
//
// Vectorize holds the knowledge base (knowledge.ts) in the "help"
// namespace and the product file in "product", so both can be found by
// meaning. The cron trigger keeps them current (syncIndex); until the
// index is built, help falls back to matching words.

import type { Job } from "./jobs";
import { jobLibrary } from "./jobs";
import { topics, type Topic } from "./knowledge";
import { hitTypes, type Filter, type HitType } from "./search";

export const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768 dimensions, cosine

export interface AiEnv {
	DB: D1Database;
	AI: Ai;
	VECTORIZE: Vectorize;
}

// AiError means Workers AI or Vectorize could not be reached or gave an
// answer that made no sense.
export class AiError extends Error {}

// run calls a Workers AI model. The bindings' model typings are narrower
// than what the models take, so the call is untyped here.
async function run(env: AiEnv, model: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
	try {
		return await (env.AI as unknown as { run(m: string, i: unknown): Promise<Record<string, unknown>> }).run(model, input);
	} catch (e) {
		console.error(`Workers AI ${model}:`, e);
		throw new AiError(e instanceof Error ? e.message : String(e));
	}
}

async function embed(env: AiEnv, texts: string[]): Promise<number[][]> {
	const out: number[][] = [];
	for (let i = 0; i < texts.length; i += 50) {
		const res = await run(env, EMBED_MODEL, { text: texts.slice(i, i + 50) });
		const data = res.data as number[][] | undefined;
		if (!Array.isArray(data)) throw new AiError("no embeddings returned");
		out.push(...data);
	}
	return out;
}

// chat asks the chat model and returns its reply: text, or with a schema,
// the parsed JSON object.
async function chat(env: AiEnv, system: string, user: string, opts: { maxTokens?: number; schema?: object } = {}): Promise<unknown> {
	const input: Record<string, unknown> = {
		messages: [{ role: "system", content: system }, { role: "user", content: user }],
		max_tokens: opts.maxTokens ?? 400,
		temperature: 0.2,
	};
	if (opts.schema) input.response_format = { type: "json_schema", json_schema: opts.schema };
	const res = await run(env, CHAT_MODEL, input);
	const reply = res.response;
	if (!opts.schema) {
		if (typeof reply !== "string" || reply.trim() === "") throw new AiError("empty reply");
		return reply;
	}
	if (typeof reply === "object" && reply !== null) return reply;
	if (typeof reply === "string") {
		const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
		try {
			return JSON.parse(json);
		} catch {
			// fall through
		}
	}
	throw new AiError("the reply was not JSON");
}

// --- The index ---

const META_ID = "meta:index";

async function sha(text: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// syncIndex brings the Vectorize index up to date with the knowledge base
// and the product file, and reports whether it changed anything. A small
// marker vector records what was last indexed, so an unchanged system
// costs one lookup.
export async function syncIndex(env: AiEnv): Promise<boolean> {
	const kb = topics();
	const help = await sha(EMBED_MODEL + JSON.stringify(kb.map((t) => [t.id, t.title, t.text])));
	const stamp = await env.DB.prepare("SELECT count(*) || '/' || coalesce(max(updated), '') AS s FROM products").first<string>("s") ?? "";
	const [meta] = await env.VECTORIZE.getByIds([META_ID]);
	const was = (meta?.metadata ?? {}) as { help?: string; products?: string; ids?: string };
	if (was.help === help && was.products === stamp) return false;

	if (was.help !== help) {
		const vectors = await embed(env, kb.map((t) => `${t.title}. ${t.text}`));
		for (let i = 0; i < kb.length; i += 500) {
			await env.VECTORIZE.upsert(kb.slice(i, i + 500).map((t, j) => ({
				id: t.id, values: vectors[i + j], namespace: "help", metadata: { title: t.title },
			})));
		}
		// Topics that no longer exist come out of the index.
		const ids = new Set(kb.map((t) => t.id));
		const gone = (was.ids ? (JSON.parse(was.ids) as string[]) : []).filter((id) => !ids.has(id));
		if (gone.length > 0) await env.VECTORIZE.deleteByIds(gone);
	}
	if (was.products !== stamp) {
		const { results } = await env.DB.prepare("SELECT sku, description FROM products ORDER BY sku LIMIT 5000")
			.all<{ sku: string; description: string }>();
		const vectors = await embed(env, results.map((p) => `${p.sku} ${p.description}`));
		for (let i = 0; i < results.length; i += 500) {
			await env.VECTORIZE.upsert(results.slice(i, i + 500).map((p, j) => ({
				id: `product:${p.sku}`, values: vectors[i + j], namespace: "product", metadata: { sku: p.sku },
			})));
		}
	}
	const marker = new Array(768).fill(0);
	marker[0] = 1;
	await env.VECTORIZE.upsert([{
		id: META_ID, values: marker, namespace: "meta",
		metadata: { help, products: stamp, ids: JSON.stringify(kb.map((t) => t.id)), at: new Date().toISOString() },
	}]);
	return true;
}

// --- Finding topics ---

const stopWords = new Set([
	"the", "and", "for", "how", "can", "what", "when", "where", "which", "who", "why", "does", "with", "that", "this",
	"from", "into", "are", "was", "you", "your", "there", "their", "have", "has", "get", "put", "see", "use",
]);

function words(text: string): string[] {
	return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !stopWords.has(w));
}

// byWords ranks topics by the question's words they contain, a stand-in
// for the index while it is empty or out of reach.
export function byWords(question: string, kb: Topic[], k: number): Topic[] {
	const q = words(question);
	if (q.length === 0) return [];
	return kb
		.map((t) => {
			const title = new Set(words(t.title));
			const text = new Set(words(t.text));
			const score = q.reduce((n, w) => n + (title.has(w) ? 3 : 0) + (text.has(w) ? 1 : 0), 0);
			return { t, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, k)
		.map((x) => x.t);
}

// findTopics returns the topics nearest a question in meaning.
export async function findTopics(env: AiEnv, question: string, k = 6): Promise<Topic[]> {
	const kb = topics();
	try {
		const [vector] = await embed(env, [question]);
		const { matches } = await env.VECTORIZE.query(vector, { topK: k, namespace: "help" });
		const byId = new Map(kb.map((t) => [t.id, t]));
		const found = matches.map((m) => byId.get(m.id)).filter((t): t is Topic => t !== undefined);
		if (found.length > 0) return found;
	} catch (e) {
		console.error("finding help topics:", e);
	}
	return byWords(question, kb, k);
}

// --- HELP ---

const helpPrompt = `You are the HELP facility of a customer information system running on an IBM mainframe, used from a 3270 terminal. The operator asks how to do something or what something means.

Answer from the reference topics only. Be brief and practical: at most 8 short lines, plain text, no markdown, no bullet symbols other than "-". Name screens by their fast path, such as =1.2, and keys by name, such as PF5. If the topics do not answer the question, say so in one line and suggest the closest option. Never invent options, keys or fields.`;

export interface Answer {
	answer: string; // empty if the model could not be reached
	topics: Topic[]; // the topics it drew on, best first
	error?: string;
}

// ask answers a question about the system.
export async function ask(env: AiEnv, question: string): Promise<Answer> {
	const found = await findTopics(env, question);
	const refs = found.map((t) => `[${t.title}${t.go ? ` - ${t.go}` : ""}] ${t.text}`).join("\n");
	try {
		const reply = await chat(env, helpPrompt, `REFERENCE TOPICS:\n${refs || "(none)"}\n\nQUESTION: ${question}`);
		return { answer: plain(reply as string), topics: found };
	} catch (e) {
		if (!(e instanceof AiError)) throw e;
		return { answer: "", topics: found, error: e.message };
	}
}

// --- Explaining abends ---

const abendPrompt = `You are a systems programmer looking at the output of a batch job on an IBM mainframe customer information system. The job ended with an abend or a non-zero return code.

Explain to the operator, in at most 8 short lines of plain text with no markdown: what failed (the step and the message), the likely cause, and what to do next. A return code of 0004 is a warning, not a failure: say what it warns about. Use only what the listing shows; if the cause is not clear from it, say what to check.`;

// explainJob explains why a job failed, from its output listing.
export async function explainJob(env: AiEnv, job: Job, output: string[]): Promise<string> {
	const def = jobLibrary[job.name];
	const about = def ? `${job.name}: ${def.title}. Steps: ${def.steps.map((s) => s.name).join(", ")}.` : job.name;
	// The end of a long listing is where the failure is.
	const listing = output.length > 80 ? ["...", ...output.slice(-80)] : output;
	const reply = await chat(env, abendPrompt, `JOB ${job.id} ${about}\nRETURN CODE: ${job.rc}\n\nOUTPUT LISTING:\n${listing.join("\n")}`);
	return plain(reply as string);
}

const tranAbendPrompt = `You are a CICS systems programmer on an IBM mainframe customer information system. An online transaction ended with an abend. You are given the transaction, the abend code, the panel it was on and the error the program raised.

Explain to the operator, in at most 8 short lines of plain text with no markdown: what the abend code means, the likely cause from the error, and what to do next (try again, report it, or check the data named). Use only what you are given; if the cause is not clear, say what to check.`;

// explainAbend explains why an online transaction abended.
export async function explainAbend(env: AiEnv, a: { tran: string; desc: string; code: string; panel: string; text: string }): Promise<string> {
	const reply = await chat(env, tranAbendPrompt, `TRANSACTION: ${a.tran} (${a.desc})\nABEND CODE: ${a.code}\nPANEL: ${a.panel}\nERROR: ${a.text}`);
	return plain(reply as string);
}

// --- Searching in plain English ---

const searchPrompt = `You turn an operator's plain-English search of a customer information system into a JSON filter. Record types:
C customers: text (name, city or phone), state, city, status A active / H on hold / C closed, over_limit (balance above credit limit), min_amount / max_amount (balance in dollars)
I invoices: text (customer name or PO number), status O open / B billed / P paid, min_amount / max_amount (invoice total), days (created in the last N days)
O purchase orders: text (vendor name), status O open / S sent / A confirmed / T in transit / R received, min_amount / max_amount (total), days
S shipments: text (customer name or tracking number), status P picking / K packed / S shipped, carrier UPS / FDX / TRK, days
V vendors: text (name or city), state, city, status A active / I inactive
P products: text (what the product is), status A active / D discontinued, low_stock (at or below reorder point), min_amount / max_amount (unit price)

States are two-letter codes (Ohio is OH). Leave out anything the operator did not ask for. Put in text only words that would appear in a name or description, never words like "customers" or "invoices".`;

const filterSchema = {
	type: "object",
	properties: {
		type: { type: "string", enum: Object.keys(hitTypes) },
		text: { type: "string" },
		state: { type: "string" },
		city: { type: "string" },
		status: { type: "string" },
		over_limit: { type: "boolean" },
		low_stock: { type: "boolean" },
		min_amount: { type: "number" },
		max_amount: { type: "number" },
		carrier: { type: "string" },
		days: { type: "number" },
	},
	required: ["type"],
};

const statusCodes: Record<HitType, string> = { C: "AHC", I: "OBP", O: "OSATR", S: "PKS", V: "AI", P: "AD" };

// parseFilter checks the model's filter and keeps only what makes sense
// for the record type.
export function parseFilter(raw: unknown): Filter {
	if (typeof raw !== "object" || raw === null) throw new AiError("no filter");
	const r = raw as Record<string, unknown>;
	const type = String(r.type ?? "").toUpperCase();
	if (!(type in hitTypes)) throw new AiError(`unknown record type ${type}`);
	const t = type as HitType;
	const f: Filter = { type: t };
	const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim().toUpperCase() : "");
	const n = (k: string) => (typeof r[k] === "number" && Number.isFinite(r[k]) ? Math.round(r[k] as number) : undefined);
	if (s("text")) f.text = s("text").slice(0, 40);
	if ("CV".includes(t) && /^[A-Z]{2}$/.test(s("state"))) f.state = s("state");
	if ("CV".includes(t) && s("city")) f.city = s("city").slice(0, 30);
	if (s("status").length === 1 && statusCodes[t].includes(s("status"))) f.status = s("status");
	if (t === "C" && r.over_limit === true) f.overLimit = true;
	if (t === "P" && r.low_stock === true) f.lowStock = true;
	if (t !== "V" && t !== "S") {
		if (n("min_amount") !== undefined) f.min = n("min_amount");
		if (n("max_amount") !== undefined) f.max = n("max_amount");
	}
	if (t === "S" && ["UPS", "FDX", "TRK"].includes(s("carrier"))) f.carrier = s("carrier");
	if ("IOS".includes(t) && (n("days") ?? 0) > 0) f.days = Math.min(n("days")!, 3660);
	return f;
}

// describe says what a filter searched for, for the message line.
export function describe(f: Filter): string {
	const parts = [hitTypes[f.type] + "S"];
	if (f.status) parts.push(`STATUS ${f.status}`);
	if (f.text) parts.push(`MATCHING ${f.text}`);
	if (f.city) parts.push(`IN ${f.city}`);
	if (f.state) parts.push(`IN ${f.state}`);
	if (f.overLimit) parts.push("OVER CREDIT LIMIT");
	if (f.lowStock) parts.push("LOW ON STOCK");
	if (f.min !== undefined) parts.push(`FROM $${f.min}`);
	if (f.max !== undefined) parts.push(`TO $${f.max}`);
	if (f.carrier) parts.push(`BY ${f.carrier}`);
	if (f.days) parts.push(`LAST ${f.days} DAYS`);
	return parts.join(" ");
}

// naturalSearch turns a plain-English search into a filter for
// filterSearch. For products it also returns the SKUs found by meaning,
// so "parts for a conveyor" can find roller chain.
export async function naturalSearch(env: AiEnv, text: string): Promise<{ filter: Filter; also: string[] }> {
	const raw = await chat(env, searchPrompt, text, { maxTokens: 200, schema: filterSchema });
	const filter = parseFilter(raw);
	let also: string[] = [];
	if (filter.type === "P" && filter.text) {
		try {
			const [vector] = await embed(env, [filter.text]);
			const { matches } = await env.VECTORIZE.query(vector, { topK: 10, namespace: "product" });
			also = matches.filter((m) => m.score >= 0.6).map((m) => m.id.replace(/^product:/, ""));
		} catch (e) {
			console.error("finding products by meaning:", e);
		}
	}
	return { filter, also };
}

// plain strips the markdown models like to add, which a 3270 cannot show.
export function plain(text: string): string {
	return text
		.replace(/\r/g, "")
		.replace(/\*\*|__|`/g, "")
		.replace(/^#+\s*/gm, "")
		.replace(/^\s*[*•]\s+/gm, "- ")
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/[–—]/g, "-")
		.replace(/[^\x20-\x7e\n]/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, 2000);
}
