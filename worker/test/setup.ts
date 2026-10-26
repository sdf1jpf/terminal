import { applyD1Migrations } from "cloudflare:test";
import { installFakes } from "./ai";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
const statements = env.TEST_SEED.split(/;\s*$/m)
	.map((s) => s.replace(/^--.*$/gm, "").trim())
	.filter(Boolean);
await env.DB.batch(statements.map((s) => env.DB.prepare(s)));

installFakes();
