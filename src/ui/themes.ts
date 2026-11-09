// Color themes: classic palettes, each with a light and a dark variant. A palette is a handful
// of colors; `tokens()` expands it to the shadcn CSS variables (plus `selected`, for the
// selected row / active item). test/themes.test.ts checks every pairing against WCAG AA.

export type Palette = {
	bg: string; // page
	fg: string; // text
	surface: string; // cards, popovers, inputs
	subtle: string; // muted / secondary backgrounds, group headers
	mutedFg: string; // secondary text
	border: string;
	primary: string;
	primaryFg: string;
	accent: string; // hover
	selected: string; // selected row, active item
	selectedFg: string;
	sidebar: string;
	ring: string;
	destructive: string;
	/** Folder / group headers: a hue that stands out from body text. */
	group: string;
};

export type Theme = { id: string; name: string; light: Palette; dark: Palette };

export const THEMES: Theme[] = [
	{
		id: "graphite",
		name: "Graphite",
		light: { bg: "#ffffff", fg: "#0a0a0a", surface: "#ffffff", subtle: "#f4f4f5", mutedFg: "#5f5f66", border: "#e4e4e7", primary: "#18181b", primaryFg: "#fafafa", accent: "#f1f1f3", selected: "#27272a", selectedFg: "#fafafa", sidebar: "#fafafa", ring: "#8f8f99", destructive: "#c81e1e", group: "#1d4ed8" },
		dark: { bg: "#09090b", fg: "#fafafa", surface: "#141417", subtle: "#1f1f23", mutedFg: "#a1a1aa", border: "#2a2a30", primary: "#ececef", primaryFg: "#18181b", accent: "#232327", selected: "#e4e4e7", selectedFg: "#09090b", sidebar: "#111114", ring: "#71717a", destructive: "#f87171", group: "#93c5fd" },
	},
	{
		id: "nord",
		name: "Nord",
		light: { bg: "#eceff4", fg: "#2e3440", surface: "#f5f7fa", subtle: "#e2e7ef", mutedFg: "#4c566a", border: "#d8dee9", primary: "#3b5b85", primaryFg: "#ffffff", accent: "#e2e7ef", selected: "#2e3440", selectedFg: "#eceff4", sidebar: "#e5e9f0", ring: "#5e81ac", destructive: "#a3434c", group: "#3b5b85" },
		dark: { bg: "#2e3440", fg: "#eceff4", surface: "#353c4a", subtle: "#3b4252", mutedFg: "#b4bccb", border: "#4c566a", primary: "#88c0d0", primaryFg: "#2e3440", accent: "#3b4252", selected: "#d8dee9", selectedFg: "#2e3440", sidebar: "#292e39", ring: "#88c0d0", destructive: "#e0868e", group: "#88c0d0" },
	},
	{
		id: "solarized",
		name: "Solarized",
		light: { bg: "#fdf6e3", fg: "#073642", surface: "#fffbee", subtle: "#eee8d5", mutedFg: "#4a5f66", border: "#e3dcc6", primary: "#1f6fa8", primaryFg: "#ffffff", accent: "#f3edda", selected: "#073642", selectedFg: "#fdf6e3", sidebar: "#f5efdc", ring: "#268bd2", destructive: "#b02a23", group: "#1a5f91" },
		dark: { bg: "#002b36", fg: "#eee8d5", surface: "#073642", subtle: "#0a3d4a", mutedFg: "#a3b1b1", border: "#164e5c", primary: "#5eaee6", primaryFg: "#002b36", accent: "#073642", selected: "#eee8d5", selectedFg: "#002b36", sidebar: "#00232c", ring: "#268bd2", destructive: "#f26b66", group: "#5eaee6" },
	},
	{
		id: "gruvbox",
		name: "Gruvbox",
		light: { bg: "#fbf1c7", fg: "#3c3836", surface: "#fdf6d8", subtle: "#f2e5bc", mutedFg: "#5f554d", border: "#e0d0a6", primary: "#076678", primaryFg: "#fbf1c7", accent: "#f2e5bc", selected: "#3c3836", selectedFg: "#fbf1c7", sidebar: "#f5e9bf", ring: "#458588", destructive: "#9d0006", group: "#076678" },
		dark: { bg: "#282828", fg: "#ebdbb2", surface: "#32302f", subtle: "#3c3836", mutedFg: "#bdae93", border: "#504945", primary: "#fabd2f", primaryFg: "#282828", accent: "#3c3836", selected: "#ebdbb2", selectedFg: "#282828", sidebar: "#1d2021", ring: "#d79921", destructive: "#fc5c48", group: "#9fbfb3" },
	},
	{
		id: "catppuccin",
		name: "Catppuccin",
		light: { bg: "#eff1f5", fg: "#4c4f69", surface: "#f6f7fa", subtle: "#e6e9ef", mutedFg: "#545770", border: "#ccd0da", primary: "#7c2fe0", primaryFg: "#ffffff", accent: "#e6e9ef", selected: "#4c4f69", selectedFg: "#eff1f5", sidebar: "#e6e9ef", ring: "#8839ef", destructive: "#b80d32", group: "#1e5ad8" },
		dark: { bg: "#1e1e2e", fg: "#cdd6f4", surface: "#24273a", subtle: "#313244", mutedFg: "#a6adc8", border: "#45475a", primary: "#cba6f7", primaryFg: "#1e1e2e", accent: "#313244", selected: "#cdd6f4", selectedFg: "#1e1e2e", sidebar: "#181825", ring: "#cba6f7", destructive: "#f38ba8", group: "#89b4fa" },
	},
	{
		id: "tokyo-night",
		name: "Tokyo Night",
		light: { bg: "#e6e7ed", fg: "#343b58", surface: "#eeeff3", subtle: "#dcdee6", mutedFg: "#4a5480", border: "#c8cbd8", primary: "#2959aa", primaryFg: "#ffffff", accent: "#dcdee6", selected: "#343b58", selectedFg: "#e6e7ed", sidebar: "#dfe0e7", ring: "#2e7de9", destructive: "#a72828", group: "#2959aa" },
		dark: { bg: "#1a1b26", fg: "#c0caf5", surface: "#1f2133", subtle: "#24283b", mutedFg: "#9aa5ce", border: "#2f3449", primary: "#7aa2f7", primaryFg: "#1a1b26", accent: "#24283b", selected: "#c0caf5", selectedFg: "#1a1b26", sidebar: "#16161e", ring: "#7aa2f7", destructive: "#f7768e", group: "#7aa2f7" },
	},
	{
		id: "rose-pine",
		name: "Rosé Pine",
		light: { bg: "#faf4ed", fg: "#575279", surface: "#fffaf3", subtle: "#f2e9e1", mutedFg: "#625e7c", border: "#dfdad9", primary: "#286983", primaryFg: "#faf4ed", accent: "#f4ede8", selected: "#575279", selectedFg: "#faf4ed", sidebar: "#f6efe8", ring: "#56949f", destructive: "#a03f5b", group: "#286983" },
		dark: { bg: "#191724", fg: "#e0def4", surface: "#1f1d2e", subtle: "#26233a", mutedFg: "#a29fbf", border: "#403d52", primary: "#c4a7e7", primaryFg: "#191724", accent: "#26233a", selected: "#e0def4", selectedFg: "#191724", sidebar: "#16141f", ring: "#c4a7e7", destructive: "#eb6f92", group: "#9ccfd8" },
	},
];

export const themeById = (id: string) => THEMES.find((t) => t.id === id) ?? THEMES[0];

/** The CSS variables a palette sets (names without the leading `--`). */
export function tokens(p: Palette): Record<string, string> {
	return {
		background: p.bg,
		foreground: p.fg,
		card: p.surface,
		"card-foreground": p.fg,
		popover: p.surface,
		"popover-foreground": p.fg,
		primary: p.primary,
		"primary-foreground": p.primaryFg,
		secondary: p.subtle,
		"secondary-foreground": p.fg,
		muted: p.subtle,
		"muted-foreground": p.mutedFg,
		accent: p.accent,
		"accent-foreground": p.fg,
		destructive: p.destructive,
		border: p.border,
		input: p.border,
		ring: p.ring,
		selected: p.selected,
		group: p.group,
		"selected-foreground": p.selectedFg,
		sidebar: p.sidebar,
		"sidebar-foreground": p.fg,
		"sidebar-primary": p.primary,
		"sidebar-primary-foreground": p.primaryFg,
		"sidebar-accent": p.accent,
		"sidebar-accent-foreground": p.fg,
		"sidebar-border": p.border,
		"sidebar-ring": p.ring,
	};
}

// ── contrast (WCAG 2.x) ──────────────────────────────────────────────────
const channel = (c: number) => {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export function luminance(hex: string) {
	const n = parseInt(hex.slice(1), 16);
	return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrast(a: string, b: string) {
	const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (l1 + 0.05) / (l2 + 0.05);
}

/** `a` over `b` at opacity `t`, as an opaque hex color. */
export function mix(a: string, b: string, t: number) {
	const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16);
	const ch = (s: number) => Math.round(((A >> s) & 255) * t + ((B >> s) & 255) * (1 - t));
	return "#" + ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0");
}

/** Text/background pairs a palette must keep readable (4.5:1, AA for normal text). */
export function textPairs(p: Palette): [string, string, string][] {
	return [
		["text on page", p.fg, p.bg],
		["text on surface", p.fg, p.surface],
		["text on subtle", p.fg, p.subtle],
		["text on hover", p.fg, p.accent],
		["text on sidebar", p.fg, p.sidebar],
		["muted on page", p.mutedFg, p.bg],
		["muted on surface", p.mutedFg, p.surface],
		["muted on subtle", p.mutedFg, p.subtle],
		["muted on sidebar", p.mutedFg, p.sidebar],
		["primary button", p.primaryFg, p.primary],
		["selected", p.selectedFg, p.selected],
		// Secondary text in a selected row is the selection text at 75% (index.css).
		["muted in selected", mix(p.selectedFg, p.selected, 0.75), p.selected],
		["destructive text", p.destructive, p.bg],
		["group header on page", p.group, p.bg],
		["group header on subtle", p.group, p.subtle],
	];
}
