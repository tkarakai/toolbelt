#!/usr/bin/env bun
// Export Running's official/dev Dock and menu bar artwork (see artwork/README.md).
// Swift is only needed to regenerate the checked-in PNGs, not to build Toolbelt.
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(join(import.meta.dir, ".."));
const stage = mkdtempSync(join(tmpdir(), "toolbelt-icons-"));
try {
    const bin = join(stage, "render-icons");
    await $`swiftc -swift-version 5 scripts/artwork/AppArt.swift scripts/artwork/main.swift -o ${bin}`;
    await $`${bin}`;
    console.log("Rendered official/dev app icons and menu bar icons from Running artwork");
} finally {
    rmSync(stage, { recursive: true, force: true });
}
