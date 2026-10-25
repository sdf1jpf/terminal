import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accessJWT } from "./access";

const worker = (exports as unknown as { default: Fetcher }).default;

async function call(method: string, path: string, body?: unknown) {
	const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await accessJWT() };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await worker.fetch(`https://api.test${path}`, {
		method, headers, body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: await res.json<any>() };
}

const widget = { sku: "wid-001", description: "test widget", unit_price: 12, on_hand: 5, reorder_point: 2, status: "a" };

describe("products", () => {
	it("lists the product file by SKU prefix", async () => {
		const all = await call("GET", "/v1/products");
		expect(all.body.length).toBeGreaterThanOrEqual(15);
		const brg = await call("GET", "/v1/products?prefix=brg");
		expect(brg.body.map((p: { sku: string }) => p.sku)).toEqual(["BRG-6204", "BRG-6310"]);
	});

	it("searches active products by SKU or description", async () => {
		const skus = async (q: string) => (await call("GET", `/v1/products?q=${q}`)).body.map((p: { sku: string }) => p.sku);
		expect(await skus("bearing")).toEqual(["BRG-6204", "BRG-6310"]);
		expect(await skus("6310")).toEqual(["BRG-6310"]);
		expect(await skus("%25")).toEqual([]);
		expect((await skus("")).length).toBeGreaterThan(0);
	});

	it("adds, refuses a duplicate SKU, and updates with optimistic locking", async () => {
		const add = await call("POST", "/v1/products", widget);
		expect(add.status).toBe(201);
		expect(add.body).toMatchObject({ sku: "WID-001", description: "TEST WIDGET", status: "A", version: 1, updated_by: "IBMUSER" });

		const dup = await call("POST", "/v1/products", widget);
		expect(dup.status).toBe(422);
		expect(dup.body.error.field).toBe("sku");

		const ok = await call("PUT", "/v1/products/wid-001", { ...add.body, on_hand: 40 });
		expect(ok.body).toMatchObject({ on_hand: 40, version: 2 });
		const stale = await call("PUT", "/v1/products/wid-001", { ...add.body, on_hand: 1 });
		expect(stale.status).toBe(409);
		expect((await call("GET", "/v1/products/NOPE")).status).toBe(404);
	});

	it("validates and names the terminal's field", async () => {
		for (const [patch, field] of [
			[{ sku: "bad sku!" }, "sku"],
			[{ description: "" }, "desc"],
			[{ unit_price: -1 }, "price"],
			[{ on_hand: -5 }, "onhand"],
			[{ status: "X" }, "status"],
		] as const) {
			const res = await call("POST", "/v1/products", Object.assign({}, widget, { sku: "VAL-1" }, patch));
			expect(res.status, JSON.stringify(patch)).toBe(422);
			expect(res.body.error.field).toBe(field);
		}
	});
});
