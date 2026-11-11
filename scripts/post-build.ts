// Keep generated bundles out of app launchers and give dev builds their explicit identity.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import config from "../electrobun.config";

const build = join(process.cwd(), config.build.buildFolder);
if (process.env.TOOLBELT_VARIANT === "dev" && process.platform === "darwin") {
    // Electrobun appends its channel to CFBundleName; show the explicit dev identity instead.
    const plist = join(build, `dev-macos-${process.arch}/Toolbelt-dev.app/Contents/Info.plist`);
    for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
        const result = Bun.spawnSync(["/usr/bin/plutil", "-replace", key, "-string", "ToolBelt Dev", plist], { stderr: "inherit" });
        if(result.exitCode !== 0) throw new Error(`Couldn't set ${key} in the dev bundle`);
    }
}

// A .noindex parent prevents Spotlight discovery; unregistering also clears Launch Services
// entries created by build tools. Installed copies in /Applications retain their registration.
if (process.platform === "darwin" && existsSync(build)) {
    const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
    for (const channel of readdirSync(build, { withFileTypes: true })) {
        if (!channel.isDirectory()) continue;
        const directory = join(build, channel.name);
        for (const app of readdirSync(directory, { withFileTypes: true })) {
            if (!app.isDirectory() || !app.name.endsWith(".app")) continue;
            const plist = join(directory, app.name, "Contents/Info.plist");
            const commit = process.env.TOOLBELT_SOURCE_COMMIT || Bun.spawnSync(["git", "rev-parse", "--short=7", "HEAD"]).stdout.toString().trim();
            for (const [key, value] of [["NSHumanReadableCopyright", "Copyright NetSense LLC."], ["CFBundleVersion", commit], ["CFBundleShortVersionString", pkg.version]]) {
                const metadata = Bun.spawnSync(["/usr/bin/plutil", "-replace", key!, "-string", value!, plist]);
                if (metadata.exitCode !== 0) throw new Error(`Couldn't set ${key} in ${app.name}`);
            }
            const result = Bun.spawnSync([lsregister, "-u", join(directory, app.name)]);
            const output = result.stdout.toString() + result.stderr.toString();
            // Launch Services returns -10814 when Spotlight already excludes the bundle.
            if (result.exitCode !== 0 && !/:\s*-10814\b/.test(output)) {
                throw new Error(`Couldn't unregister build copy ${app.name}: ${output}`);
            }
        }
    }
}
