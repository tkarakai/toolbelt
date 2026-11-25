// Helping people put ToolBelt on a phone's home screen (docs/remote-access.md). iOS gives web
// pages no way to install themselves, so it gets the exact steps for its browser; Chromium on
// Android offers a real install prompt (`beforeinstallprompt`), which ToolBelt turns into one
// button. These are the pure rules; `remote-client.tsx` applies them.

export type InstallDevice = "iphone" | "ipad" | "android" | "desktop";
export type InstallBrowser = "safari" | "chrome" | "edge" | "firefox" | "samsung" | "other";
export type InstallContext = { device: InstallDevice; browser: InstallBrowser };

/** Which device and browser, from the user agent. iPadOS reports a Mac with touch points. */
export function installContext(userAgent: string, maxTouchPoints = 0): InstallContext {
	const ua = userAgent;
	const ios = /iPhone|iPod/.test(ua) ? "iphone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1) ? "ipad" : null;
	if (ios) {
		const browser: InstallBrowser = /CriOS/.test(ua) ? "chrome" : /EdgiOS/.test(ua) ? "edge" : /FxiOS/.test(ua) ? "firefox" : /Safari/.test(ua) ? "safari" : "other";
		return { device: ios, browser };
	}
	if (/Android/.test(ua)) {
		const browser: InstallBrowser = /SamsungBrowser/.test(ua) ? "samsung" : /EdgA/.test(ua) ? "edge" : /Firefox/.test(ua) ? "firefox" : /Chrome/.test(ua) ? "chrome" : "other";
		return { device: "android", browser };
	}
	return { device: "desktop", browser: "other" };
}

/**
 * A step's text, with what to tap written as `[icon:Label]` (drawn as a button-like chip; the
 * icon is optional, `[:Add]`) and emphasis as `**word**`. `hint` is a muted line under it for
 * where people get stuck.
 */
export type InstallStep = { text: string; hint?: string };

export type InstallIcon = "share" | "more" | "dots" | "menu" | "add";
export type StepSegment =
	| { kind: "text"; text: string }
	| { kind: "strong"; text: string }
	| { kind: "control"; label: string; icon?: InstallIcon };

const ICONS: InstallIcon[] = ["share", "more", "dots", "menu", "add"];

/** Splits a step's text into plain text, emphasis and controls. */
export function stepSegments(text: string): StepSegment[] {
	const segments: StepSegment[] = [];
	const pattern = /\[([a-z]*):([^\]]+)\]|\*\*([^*]+)\*\*/g;
	let at = 0;
	for (const match of text.matchAll(pattern)) {
		if (match.index > at) segments.push({ kind: "text", text: text.slice(at, match.index) });
		if (match[3] !== undefined) segments.push({ kind: "strong", text: match[3] });
		else {
			const icon = ICONS.includes(match[1] as InstallIcon) ? (match[1] as InstallIcon) : undefined;
			segments.push({ kind: "control", label: match[2]!, ...(icon ? { icon } : {}) });
		}
		at = match.index + match[0].length;
	}
	if (at < text.length) segments.push({ kind: "text", text: text.slice(at) });
	return segments;
}

/** The step as plain words (screen readers, tests). */
export const stepText = (text: string) =>
	stepSegments(text).map((s) => (s.kind === "control" ? s.label : s.text)).join("");

export type InstallHelp =
	/** Nothing to suggest: already installed, or a computer (the Mac has the app). */
	| { kind: "none" }
	/** The browser's own install dialog is ready behind a button. */
	| { kind: "prompt" }
	/** `copyAddress`: this browser can't install; offer the address to open in another. */
	| { kind: "steps"; steps: InstallStep[]; note?: string; copyAddress?: boolean };

const deviceName = (device: InstallDevice) => (device === "ipad" ? "iPad" : device === "iphone" ? "iPhone" : "phone");

const ADD_TO_HOME = "[add:Add to Home Screen]";

/** What to offer on this device. `promptReady`: a deferred `beforeinstallprompt` is waiting. */
export function installHelp(context: InstallContext, installed: boolean, promptReady: boolean): InstallHelp {
	if (installed || context.device === "desktop") return { kind: "none" };
	const { device, browser } = context;
	// Only Chromium on Android offers a prompt (desktop Chrome emulating an iPhone fires one too).
	if (promptReady && device === "android") return { kind: "prompt" };
	if (device === "iphone" || device === "ipad") {
		const scroll = "Scroll down the list of actions if you don’t see it.";
		const add: InstallStep = { text: "Tap [:Add] at the top right" };
		const notOffered = `Not there? Open this page in **Safari** on your ${deviceName(device)} instead.`;
		if (browser === "safari")
			return {
				kind: "steps",
				steps:
					device === "ipad"
						? [{ text: "Tap [share:Share] at the top right, beside the address bar" }, { text: `Tap ${ADD_TO_HOME}`, hint: scroll }, add]
						: [
								{ text: "Tap [share:Share] in Safari’s toolbar", hint: "Don’t see it? Tap [more:More] at the bottom right first." },
								{ text: `Tap ${ADD_TO_HOME}`, hint: scroll },
								add,
							],
			};
		if (browser === "chrome")
			return {
				kind: "steps",
				steps: [{ text: "Tap [share:Share] at the right end of the address bar" }, { text: `Tap ${ADD_TO_HOME}`, hint: scroll }, add],
				note: notOffered,
			};
		if (browser === "edge")
			return {
				kind: "steps",
				steps: [{ text: "Tap [more:More] at the bottom, then [share:Share]" }, { text: `Tap ${ADD_TO_HOME}`, hint: scroll }, add],
				note: notOffered,
			};
		return {
			kind: "steps",
			steps: [{ text: "Copy this page’s address" }, { text: "Open **Safari** and paste it in the address bar" }, { text: "Safari shows how to add ToolBelt" }],
			note: "This browser can’t add apps to the home screen, but **Safari** can.",
			copyAddress: true,
		};
	}
	// Android without a ready prompt: each browser's menu has it, under its own name.
	if (browser === "samsung")
		return {
			kind: "steps",
			steps: [{ text: "Tap [menu:Menu] at the bottom right" }, { text: "Tap [:Add page to], then [:Home screen]" }, { text: "Tap [:Add]" }],
		};
	if (browser === "firefox")
		return {
			kind: "steps",
			steps: [
				{ text: "Tap [dots:Menu] beside the address bar" },
				{ text: "Tap [add:Add app to Home screen]", hint: "Some versions call it **Install**." },
				{ text: "Tap [:Add]" },
			],
		};
	if (browser === "edge")
		return {
			kind: "steps",
			steps: [{ text: "Tap [more:More] at the bottom" }, { text: "Tap [add:Add to phone]" }, { text: "Tap [:Install]" }],
		};
	if (browser === "chrome")
		return {
			kind: "steps",
			steps: [
				{ text: "Tap [dots:Menu] at the top right" },
				{ text: "Tap [add:Add to home screen]", hint: "It may be called **Install app**." },
				{ text: "Tap [:Install]" },
			],
		};
	return {
		kind: "steps",
		steps: [{ text: "Open the browser’s menu" }, { text: "Look for **Install app** or **Add to home screen**" }],
	};
}

/** The card's title for this device. */
export const installTitle = (context: InstallContext) => `Add ToolBelt to your ${deviceName(context.device)}’s home screen`;

/** The QR code's link asks the phone to show install help on arrival. */
export const INSTALL_PARAM = "install";
export const installLink = (url: string) => `${url}?${INSTALL_PARAM}`;

const BROWSER_NAMES: Record<InstallBrowser, string> = {
	safari: "Safari",
	chrome: "Chrome",
	edge: "Edge",
	firefox: "Firefox",
	samsung: "Samsung Internet",
	other: "Browser",
};

/**
 * How ToolBelt runs on this device, for a paired device's name on the Mac: an installed web app
 * and the browser it came from pair separately (iOS gives them separate storage).
 */
export function deviceLabel(context: InstallContext, standalone: boolean): string {
	if (standalone) return context.device === "desktop" ? "Web app" : "Home Screen app";
	return BROWSER_NAMES[context.browser];
}
