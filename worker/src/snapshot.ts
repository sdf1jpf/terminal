// Snapshots: a 3270 screen, or a page of printed output, drawn as HTML and
// turned into a PNG or PDF by Browser Rendering (the BROWSER binding's
// quick actions). The drawing comes from greenscreen; this module adds the
// spool's listings, a page at a time.

import { greenbarHtml, HttpError } from "@greenscreen-dev/worker";
import { printPages, type Output } from "./spool";

export { format, imageResponse, render, screenHtml, snapScreen, type Format, type SnapScreen } from "@greenscreen-dev/worker";

// listingPageHtml draws page n (from 1) of a listing on green-bar paper.
export function listingPageHtml(o: Pick<Output, "id" | "name" | "title">, lines: string[], n: number): { html: string; width: number; height: number; pages: number } {
	const pages = printPages(o, lines);
	if (n < 1 || n > pages.length) throw new HttpError(404, "not_found", `${o.id} has no page ${n} (it has ${pages.length})`);
	return { ...greenbarHtml(pages[n - 1]), pages: pages.length };
}
