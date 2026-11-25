import { describe, expect, test } from "bun:test";
import { installContext, installHelp, installLink, installTitle, stepSegments, stepText } from "../src/ui/lib/install";

const UA = {
	iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
	iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.119 Mobile/15E148 Safari/604.1",
	iphoneFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15",
	// iPadOS asks for desktop sites: it reports a Mac, but with touch points.
	ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
	androidChrome: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
	androidFirefox: "Mozilla/5.0 (Android 15; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0",
	samsung: "Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
	mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
};

describe("install context", () => {
	test("tells iPhone, iPad, Android and computers apart, with their browsers", () => {
		expect(installContext(UA.iphoneSafari, 5)).toEqual({ device: "iphone", browser: "safari" });
		expect(installContext(UA.iphoneChrome, 5)).toEqual({ device: "iphone", browser: "chrome" });
		expect(installContext(UA.iphoneFirefox, 5)).toEqual({ device: "iphone", browser: "firefox" });
		expect(installContext(UA.ipad, 5)).toEqual({ device: "ipad", browser: "safari" });
		expect(installContext(UA.androidChrome, 5)).toEqual({ device: "android", browser: "chrome" });
		expect(installContext(UA.androidFirefox, 5)).toEqual({ device: "android", browser: "firefox" });
		expect(installContext(UA.samsung, 5)).toEqual({ device: "android", browser: "samsung" });
		expect(installContext(UA.mac, 0)).toEqual({ device: "desktop", browser: "other" });
	});
});

describe("install help", () => {
	const steps = (ua: string, touch = 5) => {
		const help = installHelp(installContext(ua, touch), false, false);
		return help.kind === "steps" ? help : null;
	};

	test("nothing when installed or on a computer", () => {
		expect(installHelp(installContext(UA.iphoneSafari, 5), true, false)).toEqual({ kind: "none" });
		expect(installHelp(installContext(UA.mac), false, true)).toEqual({ kind: "none" });
	});

	test("a ready install prompt becomes one button", () => {
		expect(installHelp(installContext(UA.androidChrome, 5), false, true)).toEqual({ kind: "prompt" });
		// iOS has no prompt; one seen there comes from desktop emulation, so the steps stay.
		expect(installHelp(installContext(UA.iphoneSafari, 5), false, true).kind).toBe("steps");
	});

	const words = (ua: string) => steps(ua)?.steps.map((s) => stepText(s.text));

	test("Safari gets Share → Add to Home Screen → Add, placed for iPhone or iPad", () => {
		expect(words(UA.iphoneSafari)).toEqual(["Tap Share in Safari’s toolbar", "Tap Add to Home Screen", "Tap Add at the top right"]);
		// Safari's compact layout hides Share behind More: the hint names that button and where it is.
		expect(stepText(steps(UA.iphoneSafari)!.steps[0]!.hint!)).toBe("Don’t see it? Tap More at the bottom right first.");
		expect(words(UA.ipad)?.[0]).toBe("Tap Share at the top right, beside the address bar");
	});

	test("other iOS browsers get their own steps, or the address to open in Safari", () => {
		expect(words(UA.iphoneChrome)?.[0]).toBe("Tap Share at the right end of the address bar");
		expect(steps(UA.iphoneChrome)?.note).toContain("Safari** on your iPhone");
		expect(steps(UA.iphoneFirefox)?.copyAddress).toBe(true);
		expect(words(UA.iphoneFirefox)?.[1]).toBe("Open Safari and paste it in the address bar");
	});

	test("Android without a prompt names each browser's own menu items", () => {
		expect(words(UA.androidChrome)).toEqual(["Tap Menu at the top right", "Tap Add to home screen", "Tap Install"]);
		expect(words(UA.androidFirefox)?.[1]).toBe("Tap Add app to Home screen");
		expect(words(UA.samsung)?.[1]).toBe("Tap Add page to, then Home screen");
	});

	test("what to tap becomes a control with its icon; emphasis stays text", () => {
		expect(stepSegments("Tap [share:Share] then **Add**, or [:Done]")).toEqual([
			{ kind: "text", text: "Tap " },
			{ kind: "control", label: "Share", icon: "share" },
			{ kind: "text", text: " then " },
			{ kind: "strong", text: "Add" },
			{ kind: "text", text: ", or " },
			{ kind: "control", label: "Done" },
		]);
		expect(stepSegments("[bogus:Thing]")).toEqual([{ kind: "control", label: "Thing" }]);
	});

	test("titles and the QR link", () => {
		expect(installTitle(installContext(UA.ipad, 5))).toBe("Add ToolBelt to your iPad’s home screen");
		expect(installTitle(installContext(UA.androidChrome, 5))).toBe("Add ToolBelt to your phone’s home screen");
		expect(installLink("https://mac.example.ts.net:47380/")).toBe("https://mac.example.ts.net:47380/?install");
	});
});

describe("device label", () => {
	test("an installed app and each browser pair under their own name", async () => {
		const { deviceLabel } = await import("../src/ui/lib/install");
		expect(deviceLabel({ device: "iphone", browser: "safari" }, true)).toBe("Home Screen app");
		expect(deviceLabel({ device: "iphone", browser: "safari" }, false)).toBe("Safari");
		expect(deviceLabel({ device: "android", browser: "samsung" }, false)).toBe("Samsung Internet");
		expect(deviceLabel({ device: "desktop", browser: "other" }, true)).toBe("Web app");
	});
});
