/** Development builds have an independent macOS identity and preferences. */
export function appVariant(dev: boolean) {
    return {
        name: dev ? "ToolBelt Dev" : "ToolBelt",
        identifier: dev ? "io.github.tkarakai.toolbelt.dev" : "io.github.tkarakai.toolbelt",
        settingsFolder: dev ? "Toolbelt Dev" : "Toolbelt",
        shortcut: dev ? "Command+Control+Option+Shift+T" : "Control+Option+Shift+T",
        icons: dev ? "dev-icon.iconset" : "icon.iconset",
    };
}

/**
 * The settings folder of the app whose `Contents/Resources/app/cli/` holds `cliDir`, from the
 * bundle's `Resources/version.json` channel: ToolBelt Dev's CLI talks to ToolBelt Dev. Null
 * outside an app bundle (a source checkout) or when the file can't be read.
 */
export function bundledSettingsFolder(cliDir: string, read: (path: string) => string): string | null {
    try {
        const info = JSON.parse(read(`${cliDir.replace(/\/$/, "")}/../../version.json`)) as { channel?: unknown };
        return typeof info.channel === "string" ? appVariant(info.channel === "dev").settingsFolder : null;
    } catch {
        return null;
    }
}
