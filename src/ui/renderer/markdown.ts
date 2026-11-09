// A small Markdown parser for the `markdown` node (release notes, descriptions). It produces
// plain data that Render.tsx turns into elements — no HTML strings, so nothing a plugin sends
// can inject markup. Covers what release notes use: headings, paragraphs, lists (nested by
// indentation), quotes, fenced code, rules, GitHub tables; inline code, bold, italic,
// strikethrough, links and bare URLs. Raw HTML stays text.

export type Inline =
	| { t: "text"; text: string }
	| { t: "code"; text: string }
	| { t: "strong" | "em" | "del"; children: Inline[] }
	| { t: "link"; href: string; children: Inline[] };

export type Block =
	| { t: "heading"; level: number; children: Inline[] }
	| { t: "paragraph"; children: Inline[] }
	| { t: "code"; text: string; lang?: string }
	| { t: "quote"; children: Block[] }
	| { t: "list"; ordered: boolean; start: number; items: Block[][] }
	| { t: "rule" }
	| { t: "table"; head: Inline[][]; rows: Inline[][][] };

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const indentOf = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, "    ").length;

export function parseMarkdown(src: string): Block[] {
	return blocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

function blocks(lines: string[]): Block[] {
	const out: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}
		// fenced code
		const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
			i++; // closing fence
			out.push({ t: "code", text: body.join("\n"), lang: fence[2] || undefined });
			continue;
		}
		const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
		if (heading) {
			out.push({ t: "heading", level: heading[1].length, children: inline(heading[2]) });
			i++;
			continue;
		}
		if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
			out.push({ t: "rule" });
			i++;
			continue;
		}
		if (/^\s{0,3}>/.test(line)) {
			const body: string[] = [];
			while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
			out.push({ t: "quote", children: blocks(body) });
			continue;
		}
		if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
			const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
			const head = cells(line);
			i += 2;
			const rows: Inline[][][] = [];
			while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
			out.push({ t: "table", head, rows });
			continue;
		}
		const item = line.match(LIST_ITEM);
		if (item) {
			i = list(lines, i, out);
			continue;
		}
		// paragraph: until a blank line or another block starts
		const para: string[] = [];
		while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++].trim());
		if (!para.length) para.push(lines[i++].trim()); // a line that looked like a block but wasn't one
		out.push({ t: "paragraph", children: inline(para.join(" ")) });
	}
	return out;
}

const startsBlock = (l: string) => /^\s*(```|~~~)/.test(l) || /^\s{0,3}#{1,6}\s/.test(l) || /^\s{0,3}>/.test(l) || LIST_ITEM.test(l) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);

/** A list starting at `start`; items own the more-indented lines that follow them. */
function list(lines: string[], start: number, out: Block[]): number {
	const first = lines[start].match(LIST_ITEM)!;
	const base = indentOf(lines[start]);
	const ordered = /\d/.test(first[2]);
	const items: Block[][] = [];
	let i = start;
	while (i < lines.length) {
		const m = lines[i].match(LIST_ITEM);
		if (!m || indentOf(lines[i]) !== base || /\d/.test(m[2]) !== ordered) break;
		const body = [m[3]];
		i++;
		while (i < lines.length) {
			const l = lines[i];
			if (!l.trim()) {
				// a blank line ends the item unless the next line is indented under it
				if (i + 1 < lines.length && lines[i + 1].trim() && indentOf(lines[i + 1]) > base) {
					body.push("");
					i++;
					continue;
				}
				break;
			}
			if (indentOf(l) <= base && (LIST_ITEM.test(l) || startsBlock(l))) break;
			if (indentOf(l) <= base && !LIST_ITEM.test(l)) {
				body.push(l.trim()); // lazy continuation
				i++;
				continue;
			}
			body.push(l.slice(Math.min(indentOf(l), base + 2)));
			i++;
		}
		items.push(blocks(body));
	}
	out.push({ t: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items });
	// skip one blank line between lists of different kinds
	return i;
}

/** Inline spans. Unclosed markers stay as text. */
export function inline(src: string): Inline[] {
	const out: Inline[] = [];
	let text = "";
	const flush = () => {
		if (text) out.push({ t: "text", text });
		text = "";
	};
	let i = 0;
	while (i < src.length) {
		const rest = src.slice(i);
		const c = src[i];
		if (c === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!~|<>]/.test(src[i + 1])) {
			text += src[i + 1];
			i += 2;
			continue;
		}
		if (c === "`") {
			const ticks = rest.match(/^`+/)![0];
			const end = src.indexOf(ticks, i + ticks.length);
			if (end > 0) {
				flush();
				out.push({ t: "code", text: src.slice(i + ticks.length, end).trim() || src.slice(i + ticks.length, end) });
				i = end + ticks.length;
				continue;
			}
		}
		const link = rest.match(/^\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/);
		if (link) {
			flush();
			out.push({ t: "link", href: link[2], children: inline(link[1]) });
			i += link[0].length;
			continue;
		}
		const auto = rest.match(/^<(https?:\/\/[^\s>]+)>/) ?? (/[\s(]$|^$/.test(src.slice(0, i).slice(-1)) ? rest.match(/^(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])/) : null);
		if (auto) {
			flush();
			out.push({ t: "link", href: auto[1], children: [{ t: "text", text: auto[1] }] });
			i += auto[0].length;
			continue;
		}
		const em = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/) ?? rest.match(/^(~~)(?=\S)([\s\S]*?\S)~~/) ?? rest.match(/^(\*|_)(?=\S)([\s\S]*?\S)\1(?![\w*])/);
		if (em && !(em[1] === "_" && /\w/.test(src[i - 1] ?? ""))) {
			flush();
			out.push({ t: em[1] === "~~" ? "del" : em[1].length === 2 ? "strong" : "em", children: inline(em[2]) });
			i += em[0].length;
			continue;
		}
		text += c;
		i++;
	}
	flush();
	return out;
}

/** Only web and mail links are followed; anything else renders as text. */
export const safeHref = (href: string) => /^(https?:|mailto:)/i.test(href);
