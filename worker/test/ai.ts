// Stand-ins for Workers AI and Vectorize, which only run remotely. The
// embedding model hashes words into a vector, so texts that share words
// are near each other; the chat model answers with whatever the test
// sets. setup.ts installs them on env for every test.

import { env } from "cloudflare:workers";

type Reply = (system: string, user: string, schema: boolean) => unknown;

const DIMS = 768;

function embedOne(text: string): number[] {
	const v = new Array(DIMS).fill(0);
	for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3)) {
		let h = 0;
		for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
		v[h % DIMS] += 1;
	}
	const norm = Math.hypot(...v) || 1;
	return v.map((x) => x / norm);
}

export const fakeAI = {
	reply: (() => "THE ANSWER") as Reply,
	down: false, // every call fails, as when Workers AI cannot be reached
	calls: [] as { model: string; input: any }[],
	async run(model: string, input: any) {
		this.calls.push({ model, input });
		if (this.down) throw new Error("AI unavailable");
		if (Array.isArray(input.text)) return { shape: [input.text.length, DIMS], data: input.text.map(embedOne) };
		const [system, user] = input.messages.map((m: { content: string }) => m.content);
		return { response: this.reply(system, user, input.response_format !== undefined) };
	},
	reset() {
		this.reply = () => "THE ANSWER";
		this.down = false;
		this.calls = [];
	},
};

interface Stored { id: string; values: number[]; namespace?: string; metadata?: Record<string, unknown> }

export const fakeIndex = {
	vectors: new Map<string, Stored>(),
	async getByIds(ids: string[]) {
		return ids.map((id) => this.vectors.get(id)).filter(Boolean);
	},
	async upsert(vs: Stored[]) {
		for (const v of vs) this.vectors.set(v.id, { ...v, values: [...v.values] });
		return { mutationId: "m" };
	},
	async deleteByIds(ids: string[]) {
		for (const id of ids) this.vectors.delete(id);
		return { mutationId: "m" };
	},
	async query(vector: number[], opts: { topK?: number; namespace?: string } = {}) {
		const matches = [...this.vectors.values()]
			.filter((v) => opts.namespace === undefined || v.namespace === opts.namespace)
			.map((v) => ({ id: v.id, score: v.values.reduce((n, x, i) => n + x * vector[i], 0) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, opts.topK ?? 5);
		return { count: matches.length, matches };
	},
};

export function installFakes() {
	Object.defineProperty(env, "AI", { value: fakeAI, configurable: true });
	Object.defineProperty(env, "VECTORIZE", { value: fakeIndex, configurable: true });
}
