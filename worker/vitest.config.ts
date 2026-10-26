import { readFile } from "node:fs/promises";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// Workers AI and Vectorize only run remotely; the tests stand in for
			// them (test/ai.ts), so no Cloudflare login is needed.
			remoteBindings: false,
			miniflare: {
				bindings: {
					ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.test",
					ACCESS_AUD: "test-aud",
					TEST_MIGRATIONS: await readD1Migrations("./migrations"),
					TEST_SEED: await readFile("./seed.sql", "utf8"),
				},
			},
		}),
	],
	test: { setupFiles: ["./test/setup.ts"] },
}));
