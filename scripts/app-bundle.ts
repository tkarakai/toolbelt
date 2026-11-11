import { $ } from "bun";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
/** Materialize the real update bundle, avoiding Electrobun's self-extracting progress launcher. */
export async function extractSignedApp(
  bundle: string,
  directory: string,
  options: {
    archiveName: string;
    name?: string;
    identifier: string;
    version: string;
  },
) {
  if (!existsSync(bundle)) throw new Error(`Build archive missing: ${bundle}`);
  mkdirSync(directory, { recursive: true });
  const tar = join(directory, ".app.tar");
  writeFileSync(tar, Bun.zstdDecompressSync(readFileSync(bundle)));
  try {
    await $`tar -xf ${tar} -C ${directory}`;
  } finally {
    rmSync(tar, { force: true });
  }
  let app = join(directory, options.archiveName);
  const built = JSON.parse(
    readFileSync(join(app, "Contents/Resources/version.json"), "utf8"),
  );
  if (built.version !== options.version || built.channel !== "stable")
    throw new Error("Built app version/channel mismatch");
  const plist = join(app, "Contents/Info.plist");
  const id = (
    await $`/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" ${plist}`.text()
  ).trim();
  if (id !== options.identifier)
    throw new Error(`Built bundle identity mismatch: ${id}`);
  await $`/usr/libexec/PlistBuddy -c "Delete :CFBundleShortVersionString" ${plist}`
    .quiet()
    .nothrow();
  await $`/usr/libexec/PlistBuddy -c ${`Add :CFBundleShortVersionString string ${options.version}`} ${plist}`;
  const displayName = options.identifier === "io.github.tkarakai.toolbelt.tester" ? "ToolBelt Plugin Tester" : "ToolBelt";
  const sourceCommit = process.env.TOOLBELT_SOURCE_COMMIT || Bun.spawnSync(["git", "rev-parse", "--short=7", "HEAD"]).stdout.toString().trim();
  if (sourceCommit) await Bun.$`/usr/bin/plutil -replace CFBundleVersion -string ${sourceCommit} ${plist}`;
  await Bun.$`/usr/bin/plutil -replace NSHumanReadableCopyright -string "Copyright NetSense LLC." ${plist}`;
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    await $`/usr/bin/plutil -replace ${key} -string ${displayName} ${plist}`;
  }
  if (options.name && options.name !== options.archiveName) {
    const target = join(directory, options.name);
    rmSync(target, { recursive: true, force: true });
    renameSync(app, target);
    app = target;
  }
  await $`/usr/bin/codesign --force --sign - ${app}`;
  await $`/usr/bin/codesign --verify --strict ${app}`;
  return app;
}
