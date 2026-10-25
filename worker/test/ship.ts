// shipInvoice takes an open invoice through the warehouse, so that it can
// be billed.

import { pack, release, ship } from "../src/shipping";

export async function shipInvoice(db: D1Database, id: string) {
	const s = await release(db, "IBMUSER", id);
	await pack(db, s.id, 1, 10);
	return ship(db, "IBMUSER", s.id, "TRK");
}
