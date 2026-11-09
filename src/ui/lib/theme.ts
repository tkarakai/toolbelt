// Applies Toolbelt's theme (from its settings) to this web view: the palette's CSS variables on
// <html>, and the `dark` class. "system" follows macOS and switches live.
import { themeById, tokens } from "../themes";

const dark = matchMedia("(prefers-color-scheme: dark)");
let current = { theme: "graphite", mode: "system" as "system" | "light" | "dark" };

function apply() {
	const isDark = current.mode === "dark" || (current.mode === "system" && dark.matches);
	const palette = themeById(current.theme)[isDark ? "dark" : "light"];
	const root = document.documentElement;
	root.classList.toggle("dark", isDark);
	for (const [k, v] of Object.entries(tokens(palette))) root.style.setProperty(`--${k}`, v);
	root.style.colorScheme = isDark ? "dark" : "light";
}

dark.addEventListener("change", () => current.mode === "system" && apply());

export function setTheme(theme: string, mode: "system" | "light" | "dark") {
	current = { theme, mode };
	apply();
}

// Something sensible before the settings arrive.
apply();
