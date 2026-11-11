import { readFileSync, writeFileSync } from "node:fs";
import { SDK_VERSION } from "./src/shared/package";
import {
  json,
  run,
  updateJSONVersion,
  type ReleaseConfig,
} from "./src/release/core";
export default {
  repo: "tkarakai/toolbelt",
  hostVersion: "0.1.0",
  products: {
    app: {
      changelog: "CHANGELOG.md",
      version: () => json("package.json").version,
      setVersion: (v) => updateJSONVersion("package.json", v),
      async build() {
        await run(["bun", "run", "build"]);
        await run(["bun", "run", "dmg"]);
        await run(["bun", "scripts/build-tester.ts"]);
        const v = json("package.json").version;
        return [
          `artifacts/Toolbelt-${v}-arm64.dmg`,
          `artifacts-tester/Toolbelt-Plugin-Tester-${v}-arm64.dmg`,
          `artifacts-tester/Toolbelt-Plugin-Tester-${v}-macos-arm64.tar.gz`,
        ];
      },
    },
    sdk: {
      changelog: "packages/sdk/CHANGELOG.md",
      version: () => jsonVersion()!,
      async setVersion(v) {
        const path = "src/shared/package.ts",
          text = readFileSync(path, "utf8");
        const matches = [
          ...text.matchAll(/^export const SDK_VERSION = "([^"]+)";$/gm),
        ];
        if (matches.length !== 1 || matches[0]![1] !== SDK_VERSION)
          throw Error("SDK version adapter does not match source");
        writeFileSync(
          path,
          text.replace(matches[0]![0], `export const SDK_VERSION = "${v}";`),
        );
      },
      async build() {
        await run(["bun", "run", "sdk:package"]);
        return [`artifacts/toolbelt-sdk-${jsonVersion()}.tgz`];
      },
    },
  },
} satisfies ReleaseConfig;
function jsonVersion() {
  return /^export const SDK_VERSION = "([^"]+)";/m.exec(
    readFileSync("src/shared/package.ts", "utf8"),
  )![1];
}
