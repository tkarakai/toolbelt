// Every theme, light and dark, keeps text readable: WCAG AA (4.5:1) for each text/background
// pairing the UI uses, and 3:1 for the focus ring against the page.
import { describe, expect, test } from "bun:test";
import { THEMES, contrast, textPairs, tokens } from "../src/ui/themes";

describe.each(THEMES.flatMap((t) => (["light", "dark"] as const).map((mode) => [`${t.name} ${mode}`, t[mode]] as const)))("%s", (_name, palette) => {
	test.each(textPairs(palette))("%s ≥ 4.5:1", (_label, fg, bg) => {
		expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
	});
	test("focus ring ≥ 3:1 on the page", () => {
		expect(contrast(palette.ring, palette.bg)).toBeGreaterThanOrEqual(3);
	});
	test("defines every token as a hex color", () => {
		for (const v of Object.values(tokens(palette))) expect(v).toMatch(/^#[0-9a-f]{6}$/);
	});
});
