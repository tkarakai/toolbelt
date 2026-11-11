// Every theme, light and dark, keeps text readable: WCAG AA (4.5:1) for each text/background
// pairing the UI uses, and 3:1 for the focus ring against the page.
import { describe, expect, test } from "bun:test";
import { HUES } from "../src/shared/protocol";
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

describe.each(THEMES.flatMap(t => [t.light,t.dark]))("selection semantics", palette => {
    test("all semantic colors retain AA contrast on the selection and their pills", () => {
        const values = tokens(palette);
        for (const tone of ["default", "muted", "success", "warning", "danger", "info", ...HUES]) {
            const name = `selected-${tone}`;
            const color = values[name];
            expect(color).toMatch(/^#[0-9a-f]{6}$/);
            expect(values[`${name}-pill`]).toMatch(/^#[0-9a-f]{6}$/);
            expect(contrast(color,palette.selected)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(color,values[`${name}-pill`])).toBeGreaterThanOrEqual(4.5);
        }
    });
});

describe.each(THEMES.flatMap(theme => [theme.light, theme.dark]))("inactive selection semantics", palette => {
    test("quiet selections and semantic pills retain AA contrast", () => {
        const values = tokens(palette);
        const background = values["inactive-selected"];
        expect(contrast(values["inactive-selected-foreground"], background)).toBeGreaterThanOrEqual(4.5);
        expect(background).not.toBe(palette.selected);
        for (const tone of ["default", "muted", "success", "warning", "danger", "info", ...HUES]) {
            const foreground = values[`inactive-selected-${tone}`];
            expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(foreground, values[`inactive-selected-${tone}-pill`])).toBeGreaterThanOrEqual(4.5);
        }
    });
});

// Hover must remain visible even where the sidebar and muted surfaces share a palette.
describe.each(THEMES.flatMap(t => [t.light, t.dark]))("shared hover semantics", palette => {
    test("uses one readable hover fill across surfaces", () => {
        const values = tokens(palette);
        expect(values.accent).toBe(values["sidebar-accent"]);
        expect(contrast(values.accent, palette.sidebar)).toBeGreaterThan(1.1);
        expect(contrast(values.foreground, values.accent)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(values["muted-foreground"], values.accent)).toBeGreaterThanOrEqual(4.5);
    });
});
