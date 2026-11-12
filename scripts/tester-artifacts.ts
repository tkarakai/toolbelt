import { $ } from "bun";
import { retryDiskImage } from "./disk-image";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
/** Package the verified real app, never Electrobun's self-extracting launcher. */
export async function packageTester(
  app: string,
  output: string,
  version: string,
) {
  const archive = join(
    output,
    `Toolbelt-Plugin-Tester-${version}-macos-arm64.tar.gz`,
  );
  const stage = mkdtempSync(join(tmpdir(), "toolbelt-tester-distribution-"));
  const volume = join(stage, "Toolbelt Plugin Tester");
  try {
    await $`mkdir -p ${volume}`;
    cpSync(app, join(volume, "Toolbelt Plugin Tester.app"), {
      recursive: true,
    });
    await $`/usr/bin/codesign --verify --strict ${join(volume, "Toolbelt Plugin Tester.app")}`;
    await $`tar --format ustar -czf ${archive} -C ${volume} ${"Toolbelt Plugin Tester.app"}`.env(
      { ...process.env, COPYFILE_DISABLE: "1" },
    );
    symlinkSync("/Applications", join(volume, "Applications"));
    const dmg = join(output, `Toolbelt-Plugin-Tester-${version}-arm64.dmg`);
    await retryDiskImage("Creating disk image", () => $`/usr/bin/hdiutil create -volname ${"Toolbelt Plugin Tester"} -srcfolder ${volume} -fs APFS -ov -format ULMO ${dmg}`.nothrow());
    const mount = join(stage, "mounted");
    await $`mkdir -p ${mount}`;
    let mounted = false;
    try {
      await retryDiskImage("Mounting tester disk image", () => $`/usr/bin/hdiutil attach -nobrowse -readonly -noautoopen -mountpoint ${mount} ${dmg}`.nothrow());
      mounted = true;
      const mountedApp = join(mount, "Toolbelt Plugin Tester.app"),
        plist = join(mountedApp, "Contents/Info.plist");
      const id = (
          await $`/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" ${plist}`.text()
        ).trim(),
        built = (
          await $`/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" ${plist}`.text()
        ).trim();
      if (id !== "io.github.tkarakai.toolbelt.tester" || built !== version)
        throw new Error("Tester disk image identity/version mismatch");
      await $`/usr/bin/codesign --verify --strict ${mountedApp}`;
    } finally {
      if (mounted)
        await $`/usr/bin/hdiutil detach -force ${mount}`.quiet().nothrow();
    }
    return { archive, dmg };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
