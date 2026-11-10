/** Development builds have an independent macOS identity and preferences. */
export function appVariant(dev: boolean) {
    return {
        name: dev ? "Toolbelt Dev" : "Toolbelt",
        identifier: dev ? "io.github.tkarakai.toolbelt.dev" : "io.github.tkarakai.toolbelt",
        settingsFolder: dev ? "Toolbelt Dev" : "Toolbelt",
        shortcut: dev ? "Command+Control+Option+Shift+T" : "Control+Option+Shift+T",
        icons: dev ? "dev-icon.iconset" : "icon.iconset",
    };
}
