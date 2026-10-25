import { readFile } from "node:fs/promises";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					CUSTAPI_USERS: "IBMUSER:SYS1,GUEST:GUEST",
					TEST_MIGRATIONS: await readD1Migrations("./migrations"),
					TEST_SEED: await readFile("./seed.sql", "utf8"),
				},
			},
		}),
	],
	test: { setupFiles: ["./test/setup.ts"] },
}));
