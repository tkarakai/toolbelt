import { mkdirSync, writeFileSync } from "node:fs";
import { extractArchive } from "../src/bun/packages";
import { parsePackageManifest } from "../src/shared/package";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const {url,sha256} = JSON.parse(readFileSync("seed.config.json","utf8"));
mkdirSync("build-seed", { recursive: true });
let bytes: Uint8Array = new Uint8Array();
if (await Bun.file("build-seed/demo.tar.gz").exists())
  bytes = new Uint8Array(
    await Bun.file("build-seed/demo.tar.gz").arrayBuffer(),
  );
if (
  !bytes.length ||
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== sha256
) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error("Demo seed unavailable");
  bytes = new Uint8Array(await response.arrayBuffer());
}
if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== sha256)
  throw new Error("Demo seed checksum mismatch");
const temp = mkdtempSync(join(tmpdir(), "tb-seed-"));
try {
  extractArchive(bytes, temp);
  const manifest = parsePackageManifest(
    JSON.parse(readFileSync(join(temp, "toolbelt.json"), "utf8")),
  );
  if (
    manifest.id !== "sdk-demo" ||
    manifest.repo !== "tkarakai/toolbelt-sdk-demo"
  )
    throw new Error("Seed identity mismatch");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
await Bun.write("build-seed/demo.tar.gz", bytes);
writeFileSync(
  "build-seed/seed.json",
  JSON.stringify({ repo: "tkarakai/toolbelt-sdk-demo", sha256, url }),
);
console.log("Verified prebuilt SDK demo seed; no plugin source built");
