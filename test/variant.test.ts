import { expect, test } from "bun:test";
import { appVariant } from "../src/shared/variant";
test("dev and official apps have separate macOS identities, settings, icons and global shortcuts", () => {
    const dev = appVariant(true), official = appVariant(false);
    expect(official.name).toBe("Toolbelt");
    expect(official.identifier).toBe("io.github.tkarakai.toolbelt");
    for(const key of ["name", "identifier", "settingsFolder", "shortcut", "icons"] as const) expect(dev[key]).not.toBe(official[key]);
    expect(dev.shortcut).toContain("Command+");
});
