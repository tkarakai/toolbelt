// Electrobun appends its channel to CFBundleName. Give the dev build a clean, explicit
// macOS display identity after wrapping, without changing the stable release layout.
import { join } from "node:path";
if (process.env.TOOLBELT_VARIANT === "dev" && process.platform === "darwin") {
    const plist = join(process.cwd(), `build/dev-macos-${process.arch}/Toolbelt-dev.app/Contents/Info.plist`);
    for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
        const result = Bun.spawnSync(["/usr/bin/plutil", "-replace", key, "-string", "Toolbelt Dev", plist], { stderr: "inherit" });
        if(result.exitCode !== 0) throw new Error(`Couldn't set ${key} in the dev bundle`);
    }
}
