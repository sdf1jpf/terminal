// The customer record and its edit rules. The JSON field names match
// internal/customer/customer.go in the Go client, and validation errors
// name the terminal's input fields (e.g. "addr", "limit").

import { HttpError, int, str } from "./http";

export interface Customer {
	id: string;
	name: string;
	address: string;
	city: string;
	state: string;
	zip: string;
	phone: string;
	credit_limit: number;
	balance: number;
	status: string; // A=active, H=hold, C=closed
	version: number;
	updated: string; // RFC 3339, UTC
	updated_by: string;
}

export const customerFields = [
	"id", "name", "address", "city", "state", "zip", "phone",
	"credit_limit", "balance", "status", "version", "updated", "updated_by",
] as const;

// Editable is what a client may set. Balance, version and audit fields are
// owned by the server.
export type Editable = Pick<Customer, "name" | "address" | "city" | "state" | "zip" | "phone" | "credit_limit" | "status">;

// parseEditable reads the editable fields from a request body, normalizes
// them and applies the edit rules. It also returns the client's version.
export function parseEditable(body: Record<string, unknown>): { fields: Editable; version: number } {
	const up = (k: string) => str(body, k).trim().toUpperCase();
	const fields: Editable = {
		name: up("name"),
		address: up("address"),
		city: up("city"),
		state: up("state"),
		zip: up("zip"),
		phone: up("phone"),
		credit_limit: int(body, "credit_limit"),
		status: up("status"),
	};
	// The remaining keys are accepted but must be well-typed.
	str(body, "id"), str(body, "updated"), str(body, "updated_by"), int(body, "balance");
	const version = int(body, "version");

	const bad = validate(fields);
	if (bad) throw new HttpError(422, "invalid", bad.message, bad.field);
	return { fields, version };
}

const reState = /^[A-Z]{2}$/;
const reZip = /^[0-9]{5}$/;
const rePhone = /^[0-9]{3}-[0-9]{3}-[0-9]{4}$/;

export function validate(c: Editable): { field: string; message: string } | null {
	const bad = (field: string, message: string) => ({ field, message });
	if (c.name === "") return bad("name", "customer name is required");
	if (c.name.length > 30) return bad("name", "customer name is limited to 30 characters");
	if (c.address.length > 30) return bad("addr", "address is limited to 30 characters");
	if (c.city === "") return bad("city", "city is required");
	if (c.city.length > 18) return bad("city", "city is limited to 18 characters");
	if (!reState.test(c.state)) return bad("state", "state must be a two letter code");
	if (!reZip.test(c.zip)) return bad("zip", "zip code must be five digits");
	if (c.phone !== "" && !rePhone.test(c.phone)) return bad("phone", "phone must be in the form NNN-NNN-NNNN");
	if (c.credit_limit < 0 || c.credit_limit > 999_999_999) {
		return bad("limit", "credit limit must be a whole, positive number");
	}
	if (!["A", "H", "C"].includes(c.status)) return bad("status", "status must be A (active), H (hold) or C (closed)");
	return null;
}
