// A small PDF writer, enough for what the system prints: text in the
// standard fonts (nothing to embed), filled boxes, rules and circles.
// Positions are in points from the top left of the page, which is how the
// layouts think; the writer turns them into PDF's bottom-left coordinates.
// Text is ASCII: anything else prints as "?", as it would on a 1403 chain.

export type RGB = readonly [number, number, number]; // 0-1 each

export type Font = "mono" | "mono-bold" | "sans" | "sans-bold";

const fonts: Record<Font, { id: string; base: string }> = {
	mono: { id: "F1", base: "Courier" },
	"mono-bold": { id: "F2", base: "Courier-Bold" },
	sans: { id: "F3", base: "Helvetica" },
	"sans-bold": { id: "F4", base: "Helvetica-Bold" },
};

export interface TextOpts {
	size?: number; // points, default 10
	font?: Font; // default mono
	color?: RGB; // default black
}

interface Page {
	width: number;
	height: number;
	ops: string[];
}

export class Pdf {
	private pages: Page[] = [];

	constructor(readonly title = "") {}

	// page starts a new page, letter size unless told otherwise.
	page(width = 612, height = 792): this {
		this.pages.push({ width, height, ops: [] });
		return this;
	}

	get pageCount(): number {
		return this.pages.length;
	}

	// text draws a line of text with its baseline at y.
	text(x: number, y: number, s: string, o: TextOpts = {}): this {
		const p = this.cur();
		const f = fonts[o.font ?? "mono"];
		p.ops.push(
			`BT ${rgb(o.color ?? [0, 0, 0])} rg /${f.id} ${n(o.size ?? 10)} Tf ${n(x)} ${n(p.height - y)} Td (${escape(s)}) Tj ET`,
		);
		return this;
	}

	// rect fills a box whose top left corner is x, y.
	rect(x: number, y: number, w: number, h: number, fill: RGB): this {
		const p = this.cur();
		p.ops.push(`${rgb(fill)} rg ${n(x)} ${n(p.height - y - h)} ${n(w)} ${n(h)} re f`);
		return this;
	}

	// box strokes the outline of a box.
	box(x: number, y: number, w: number, h: number, color: RGB = [0, 0, 0], width = 0.75): this {
		const p = this.cur();
		p.ops.push(`${rgb(color)} RG ${n(width)} w ${n(x)} ${n(p.height - y - h)} ${n(w)} ${n(h)} re S`);
		return this;
	}

	line(x1: number, y1: number, x2: number, y2: number, color: RGB = [0, 0, 0], width = 0.75): this {
		const p = this.cur();
		p.ops.push(`${rgb(color)} RG ${n(width)} w ${n(x1)} ${n(p.height - y1)} m ${n(x2)} ${n(p.height - y2)} l S`);
		return this;
	}

	// circle fills a circle centered on x, y, from four Bezier curves.
	circle(x: number, y: number, r: number, fill: RGB): this {
		const p = this.cur();
		const cy = p.height - y;
		const k = r * 0.5523;
		p.ops.push(
			`${rgb(fill)} rg ${n(x + r)} ${n(cy)} m ` +
				`${n(x + r)} ${n(cy + k)} ${n(x + k)} ${n(cy + r)} ${n(x)} ${n(cy + r)} c ` +
				`${n(x - k)} ${n(cy + r)} ${n(x - r)} ${n(cy + k)} ${n(x - r)} ${n(cy)} c ` +
				`${n(x - r)} ${n(cy - k)} ${n(x - k)} ${n(cy - r)} ${n(x)} ${n(cy - r)} c ` +
				`${n(x + k)} ${n(cy - r)} ${n(x + r)} ${n(cy - k)} ${n(x + r)} ${n(cy)} c f`,
		);
		return this;
	}

	// bytes lays out the file. Everything in it is ASCII, so string
	// lengths are byte offsets.
	bytes(): Uint8Array {
		if (this.pages.length === 0) this.page();
		const objs: string[] = [];
		const add = (body: string) => objs.push(body); // object number = index + 1

		add("<< /Type /Catalog /Pages 2 0 R >>");
		add(""); // the page tree, filled in below
		const fontRefs = Object.values(fonts).map((f) => {
			add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`);
			return `/${f.id} ${objs.length} 0 R`;
		});
		add(`<< /Title (${escape(this.title)}) /Producer (CUSTAPI PRINT SERVICES) >>`);
		const info = objs.length;
		const kids: string[] = [];
		for (const p of this.pages) {
			const stream = p.ops.join("\n");
			add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
			add(
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(p.width)} ${n(p.height)}] ` +
					`/Resources << /Font << ${fontRefs.join(" ")} >> >> /Contents ${objs.length} 0 R >>`,
			);
			kids.push(`${objs.length} 0 R`);
		}
		objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;

		let out = "%PDF-1.4\n";
		const offsets: number[] = [];
		objs.forEach((body, i) => {
			offsets.push(out.length);
			out += `${i + 1} 0 obj\n${body}\nendobj\n`;
		});
		const xref = out.length;
		out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
		out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
		out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
		return new TextEncoder().encode(out);
	}

	private cur(): Page {
		if (this.pages.length === 0) this.page();
		return this.pages[this.pages.length - 1];
	}
}

// pdfResponse sends a PDF for download.
export function pdfResponse(bytes: Uint8Array, filename: string): Response {
	return new Response(bytes, {
		headers: {
			"Content-Type": "application/pdf",
			"Content-Disposition": `inline; filename="${filename}"`,
		},
	});
}

function escape(s: string): string {
	return s.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, "\\$&");
}

function n(v: number): string {
	return String(Math.round(v * 100) / 100);
}

function rgb(c: RGB): string {
	return c.map(n).join(" ");
}
