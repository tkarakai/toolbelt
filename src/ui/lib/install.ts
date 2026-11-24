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

export type InstallStep = { text: string; icon?: "share" | "menu" | "plus" };

export type InstallHelp =
	/** Nothing to suggest: already installed, or a computer (the Mac has the app). */
	| { kind: "none" }
	/** The browser's own install dialog is ready behind a button. */
	| { kind: "prompt" }
	| { kind: "steps"; steps: InstallStep[]; note?: string };

const deviceName = (device: InstallDevice) => (device === "ipad" ? "iPad" : device === "iphone" ? "iPhone" : "phone");

/** What to offer on this device. `promptReady`: a deferred `beforeinstallprompt` is waiting. */
export function installHelp(context: InstallContext, installed: boolean, promptReady: boolean): InstallHelp {
	if (installed || context.device === "desktop") return { kind: "none" };
	const { device, browser } = context;
	// Only Chromium on Android offers a prompt (desktop Chrome emulating an iPhone fires one too).
	if (promptReady && device === "android") return { kind: "prompt" };
	if (device === "iphone" || device === "ipad") {
		if (browser === "safari")
			return {
				kind: "steps",
				steps: [
					{ text: device === "ipad" ? "Tap Share at the top of Safari" : "Tap Share in Safari’s toolbar (or in its ⋯ menu)", icon: "share" },
					{ text: "Choose Add to Home Screen", icon: "plus" },
					{ text: "Tap Add" },
				],
			};
		if (browser === "chrome" || browser === "edge")
			return {
				kind: "steps",
				steps: [
					{ text: "Tap Share in the address bar", icon: "share" },
					{ text: "Choose Add to Home Screen", icon: "plus" },
					{ text: "Tap Add" },
				],
				note: `If Add to Home Screen isn’t offered, open this page in Safari on your ${deviceName(device)}.`,
			};
		return {
			kind: "steps",
			steps: [
				{ text: "Open this page in Safari" },
				{ text: "Tap Share, then Add to Home Screen", icon: "share" },
			],
			note: "This browser can’t add web apps to the home screen.",
		};
	}
	// Android without a ready prompt: the browser menu has it.
	if (browser === "firefox")
		return { kind: "steps", steps: [{ text: "Open Firefox’s ⋮ menu", icon: "menu" }, { text: "Choose Install", icon: "plus" }] };
	if (browser === "samsung")
		return { kind: "steps", steps: [{ text: "Open the ≡ menu", icon: "menu" }, { text: "Choose Add page to, then Home screen", icon: "plus" }] };
	return {
		kind: "steps",
		steps: [{ text: "Open the browser’s ⋮ menu", icon: "menu" }, { text: "Choose Install app or Add to Home screen", icon: "plus" }],
	};
}

/** The card's title for this device. */
export const installTitle = (context: InstallContext) => `Install ToolBelt on this ${deviceName(context.device)}`;

/** The QR code's link asks the phone to show install help on arrival. */
export const INSTALL_PARAM = "install";
export const installLink = (url: string) => `${url}?${INSTALL_PARAM}`;
