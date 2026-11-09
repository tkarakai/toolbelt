import { describe, expect, test } from "bun:test";
import { inline, parseMarkdown, safeHref } from "../src/ui/renderer/markdown";

describe("blocks", () => {
	test("headings, paragraphs, rules, code", () => {
		expect(parseMarkdown("## v1.2.0\n\nFirst line\nsecond line\n\n---\n\n```sh\nbrew upgrade\n```")).toEqual([
			{ t: "heading", level: 2, children: [{ t: "text", text: "v1.2.0" }] },
			{ t: "paragraph", children: [{ t: "text", text: "First line second line" }] },
			{ t: "rule" },
			{ t: "code", text: "brew upgrade", lang: "sh" },
		]);
	});

	test("nested lists", () => {
		const [list] = parseMarkdown("- one\n- two\n  - two.a\n  - two.b\n- three");
		expect(list).toMatchObject({ t: "list", ordered: false });
		const items = (list as { items: unknown[][] }).items;
		expect(items.length).toBe(3);
		expect(items[1][1]).toMatchObject({ t: "list", items: [[{ t: "paragraph" }], [{ t: "paragraph" }]] });
	});

	test("ordered lists keep their start", () => {
		expect(parseMarkdown("3. c\n4. d")[0]).toMatchObject({ t: "list", ordered: true, start: 3 });
	});

	test("quotes and tables", () => {
		expect(parseMarkdown("> note\n> more")[0]).toMatchObject({ t: "quote", children: [{ t: "paragraph" }] });
		const table = parseMarkdown("| a | b |\n|---|:-:|\n| 1 | 2 |")[0];
		expect(table).toMatchObject({ t: "table", head: [[{ text: "a" }], [{ text: "b" }]], rows: [[[{ text: "1" }], [{ text: "2" }]]] });
	});

	test("raw HTML stays text", () => {
		expect(parseMarkdown("<script>alert(1)</script>")).toEqual([{ t: "paragraph", children: [{ t: "text", text: "<script>alert(1)</script>" }] }]);
	});
});

describe("inline", () => {
	test("code, bold, italic, strikethrough", () => {
		expect(inline("use `bun` **now** _or_ ~~never~~")).toEqual([
			{ t: "text", text: "use " },
			{ t: "code", text: "bun" },
			{ t: "text", text: " " },
			{ t: "strong", children: [{ t: "text", text: "now" }] },
			{ t: "text", text: " " },
			{ t: "em", children: [{ t: "text", text: "or" }] },
			{ t: "text", text: " " },
			{ t: "del", children: [{ t: "text", text: "never" }] },
		]);
	});

	test("links and bare URLs", () => {
		expect(inline("[#123](https://github.com/x/y/pull/123)")).toEqual([{ t: "link", href: "https://github.com/x/y/pull/123", children: [{ t: "text", text: "#123" }] }]);
		expect(inline("see https://example.com/a.")).toEqual([{ t: "text", text: "see " }, { t: "link", href: "https://example.com/a", children: [{ t: "text", text: "https://example.com/a" }] }, { t: "text", text: "." }]);
	});

	test("snake_case words aren't emphasis; unclosed markers are text", () => {
		expect(inline("snake_case_name")).toEqual([{ t: "text", text: "snake_case_name" }]);
		expect(inline("2 * 3")).toEqual([{ t: "text", text: "2 * 3" }]);
	});

	test("only web and mail links are followed", () => {
		expect(safeHref("https://a.b")).toBe(true);
		expect(safeHref("mailto:x@y")).toBe(true);
		expect(safeHref("javascript:alert(1)")).toBe(false);
		expect(safeHref("file:///etc/passwd")).toBe(false);
	});
});
