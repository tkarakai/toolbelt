import { mkdirSync, cpSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { SDK_VERSION } from "../src/shared/package";
const output = resolve(process.env.TOOLBELT_SDK_OUTPUT ?? "artifacts");
const root = join(output, "sdk-package");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "src"), { recursive: true });
cpSync("src/sdk", join(root, "src/sdk"), { recursive: true });
mkdirSync(join(root, "src/shared"), { recursive: true });
for (const file of ["protocol.ts", "time.ts", "package.ts", "validation.ts"])
  cpSync(`src/shared/${file}`, join(root, "src/shared", file));
cpSync("packages/sdk/README.md", join(root, "README.md"));
cpSync("packages/sdk/CHANGELOG.md", join(root, "CHANGELOG.md"));
mkdirSync(join(root, "release"), { recursive: true });
for (const [entry, name] of [
  ["src/release/cli.ts", "cli.js"],
  ["src/release/core.ts", "index.js"],
]) {
  const build = await Bun.build({
    entrypoints: [entry!],
    target: "bun",
    packages: "bundle",
  });
  if (!build.success)
    throw new AggregateError(build.logs, "SDK release tool build failed");
  await Bun.write(join(root, "release", name!), build.outputs[0]!);
}
chmodSync(join(root, "release/cli.js"), 0o755);
cpSync("src/release/index.d.ts", join(root, "release/index.d.ts"));
writeFileSync(
  join(root, "package.json"),
  JSON.stringify(
    {
      name: "@toolbelt/sdk",
      version: SDK_VERSION,
      type: "module",
      bin: { "toolbelt-release": "./release/cli.js" },
      exports: {
        ".": "./src/sdk/index.ts",
        "./search": "./src/sdk/search.ts",
        "./testing": "./src/sdk/testing.ts",
        "./validation": "./src/shared/validation.ts",
        "./protocol": "./src/shared/protocol.ts",
        "./package": "./src/shared/package.ts",
        "./release": {
          types: "./release/index.d.ts",
          default: "./release/index.js",
        },
      },
    },
    null,
    2,
  ),
);
const archive = join(output, `toolbelt-sdk-${SDK_VERSION}.tgz`);
const proc = Bun.spawn(["tar", "-czf", archive, "-C", root, "."], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
if (await proc.exited) throw new Error("SDK packaging failed");
console.log(archive);
