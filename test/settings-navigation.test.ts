import { expect, test } from "bun:test";
import { settingsReturnHash } from "../src/shared/navigation";

test("closing Settings opened directly from the tray selects the first plugin", () => {
    expect(settingsReturnHash("", "toolbelt", ["first", "second"])).toBe("#/first");
});
test("closing Settings preserves an existing plugin and screen", () => {
    expect(settingsReturnHash("#/second/details", "first", ["first", "second"])).toBe("#/second/details");
});
test("removed previous plugins fall back to a valid remembered plugin or the first plugin", () => {
    expect(settingsReturnHash("#/removed", "second", ["first", "second"])).toBe("#/second");
    expect(settingsReturnHash("#/removed", "removed", ["first"])).toBe("#/first");
});
