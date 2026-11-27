import { describe, expect, test } from "bun:test";
import { seedNotes, seedVersion } from "../src/release/seed-notes";

describe("seed:update pull request notes", () => {
  test("the version in a seed URL", () => {
    expect(seedVersion("https://github.com/tkarakai/toolbelt-sdk-demo/releases/download/v0.3.0/toolbelt-sdk-demo-0.3.0-portable.tar.gz")).toBe("0.3.0");
    expect(seedVersion("https://github.com/x/y/releases/download/1.2.0-rc.1/a.tar.gz")).toBe("1.2.0-rc.1");
    for (const url of [undefined, 42, "", "https://example.com/a.tar.gz"]) expect(seedVersion(url)).toBeNull();
  });
  const base = { repo: "tkarakai/toolbelt-sdk-demo", tag: "v0.4.0", version: "0.4.0", asset: "toolbelt-sdk-demo-0.4.0-portable.tar.gz", sha256: "f".repeat(64) };
  test("Markdown, not JSON, naming the release, the old version, the asset and the hash", () => {
    const body = seedNotes({ ...base, previous: "0.3.0" });
    expect(body.trimStart().startsWith("{")).toBe(false);
    expect(body).toContain("Bundles SDK Explorer **0.4.0** ([v0.4.0](https://github.com/tkarakai/toolbelt-sdk-demo/releases/tag/v0.4.0)) as the app's seed, replacing 0.3.0.");
    expect(body).toContain("`toolbelt-sdk-demo-0.4.0-portable.tar.gz`");
    expect(body).toContain("f".repeat(64));
    expect(body).toContain("publishes nothing");
  });
  test("no replacing clause without a different previous version", () => {
    for (const previous of [null, "0.4.0"]) expect(seedNotes({ ...base, previous })).not.toContain("replacing");
  });
});
