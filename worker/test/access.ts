// A stand-in for Cloudflare Access: a signing key whose public half is
// served at the team's certs URL, and a function to mint JWTs with it.

import { env } from "cloudflare:workers";
import { vi } from "vitest";

const { publicKey, privateKey } = (await crypto.subtle.generateKey(
	{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
	true,
	["sign", "verify"],
)) as CryptoKeyPair;
const jwk = { ...((await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey), kid: "test-kid" };

export const certsURL = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;

const realFetch = globalThis.fetch;
export const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url === certsURL) return Response.json({ keys: [jwk] });
	return realFetch(input, init);
});

function b64url(data: Uint8Array | string): string {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// accessJWT signs claims as Access would; override any of the defaults.
export async function accessJWT(claims: Record<string, unknown> = {}, kid = "test-kid"): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const body = {
		iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
		aud: [env.ACCESS_AUD],
		email: "ibmuser@example.com",
		iat: now,
		nbf: now,
		exp: now + 3600,
		...claims,
	};
	const input = `${b64url(JSON.stringify({ alg: "RS256", kid }))}.${b64url(JSON.stringify(body))}`;
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input));
	return `${input}.${b64url(new Uint8Array(sig))}`;
}
