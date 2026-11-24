import { describe, expect, test } from "bun:test";
import { installContext, installHelp, installLink, installTitle } from "../src/ui/lib/install";

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

	test("Safari gets Share → Add to Home Screen, placed for iPhone or iPad", () => {
		expect(steps(UA.iphoneSafari)?.steps.map((s) => s.text)).toEqual(["Tap Share in Safari’s toolbar (or in its ⋯ menu)", "Choose Add to Home Screen", "Tap Add"]);
		expect(steps(UA.ipad)?.steps[0]?.text).toBe("Tap Share at the top of Safari");
	});

	test("other iOS browsers get their steps or are sent to Safari", () => {
		expect(steps(UA.iphoneChrome)?.steps[0]?.text).toBe("Tap Share in the address bar");
		expect(steps(UA.iphoneChrome)?.note).toContain("Safari on your iPhone");
		expect(steps(UA.iphoneFirefox)?.steps[0]?.text).toBe("Open this page in Safari");
	});

	test("Android without a prompt points to the browser menu", () => {
		expect(steps(UA.androidChrome)?.steps.map((s) => s.icon)).toEqual(["menu", "plus"]);
		expect(steps(UA.androidFirefox)?.steps[1]?.text).toBe("Choose Install");
		expect(steps(UA.samsung)?.steps[1]?.text).toContain("Home screen");
	});

	test("titles and the QR link", () => {
		expect(installTitle(installContext(UA.ipad, 5))).toBe("Install ToolBelt on this iPad");
		expect(installTitle(installContext(UA.androidChrome, 5))).toBe("Install ToolBelt on this phone");
		expect(installLink("https://mac.example.ts.net:47380/")).toBe("https://mac.example.ts.net:47380/?install");
	});
});
