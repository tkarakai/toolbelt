import { test, expect } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractArchive } from "../src/bun/packages";
import { LIMITS } from "../src/shared/package";
function tar(
  entries: { name: string; type?: string; body?: string }[],
  trailer = true,
) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512),
      body = Buffer.from(entry.body ?? "");
    header.write(entry.name, 0, 100);
    header.write("0000644\0", 100, 8);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    header.write("        ", 148, 8);
    header.write(entry.type ?? "0", 156, 1);
    header.write("ustar\0", 257, 6);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  if (trailer) chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}
const m = { name: "toolbelt.json", body: "{}" };
for (const entry of [
  { name: "../escape" },
  { name: "/absolute" },
  { name: "nested/../../escape" },
  { name: "link", type: "2" },
  { name: "device", type: "3" },
])
  test(`archive rejects ${entry.name} type ${entry.type ?? "file"}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-malicious-"));
    try {
      expect(() => extractArchive(tar([m, entry]), dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
test("duplicate normalized paths and missing trailers reject", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-malicious-"));
  try {
    expect(() =>
      extractArchive(tar([m, { ...m, name: "./toolbelt.json" }]), dir),
    ).toThrow("Duplicate");
    expect(() => extractArchive(tar([m], false), dir)).toThrow("Incomplete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("decompression expansion limit rejects compressed bombs", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-bomb-")),
    limit = LIMITS.expandedBytes;
  try {
    LIMITS.expandedBytes = 1024;
    expect(() => extractArchive(gzipSync(Buffer.alloc(2048)), dir)).toThrow();
  } finally {
    LIMITS.expandedBytes = limit;
    rmSync(dir, { recursive: true, force: true });
  }
});
