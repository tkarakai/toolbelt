import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json" with { type: "json" };

import { appVariant } from "./src/shared/variant";
const variant = appVariant(process.env.TOOLBELT_VARIANT === "dev");
const webAppIcon = process.env.TOOLBELT_VARIANT === "dev" ? "assets/web-app-icon-dev" : "assets/web-app-icon";

export default {
	app: {
		name: "Toolbelt",
		identifier: variant.identifier,
		version: pkg.version,
	},
	build: {
		// Build copies must stay out of Spotlight and app launchers; install from the DMG.
		buildFolder: "build.noindex",
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		// Vite builds the web app to dist/; built-in plugins are bundled to build-plugins/.
		copy: {
			"dist/index.html": "views/ui/index.html",
			"dist/assets": "views/ui/assets",
			// Remote access serves views/ui to other devices as an installable web app.
			"dist/sw.js": "views/ui/sw.js",
			"dist/manifest.webmanifest": "views/ui/manifest.webmanifest",
			// Full-bleed home-screen icons (bun run icons), official or dev artwork.
			[`${webAppIcon}-180.png`]: "views/ui/pwa/icon-180.png",
			[`${webAppIcon}-192.png`]: "views/ui/pwa/icon-192.png",
			[`${webAppIcon}-512.png`]: "views/ui/pwa/icon-512.png",
			"assets/tray-icon-dev@2x.png": "views/assets/tray-icon-dev@2x.png",
			"assets/tray-icon@2x.png": "views/assets/tray-icon@2x.png",
			// With a neutral badge, when an update is available (scripts/make-icons.ts).
			"assets/tray-icon-update-light@2x.png": "views/assets/tray-icon-update-light@2x.png",
			"assets/tray-icon-update-dark@2x.png": "views/assets/tray-icon-update-dark@2x.png",
			"assets/tray-icon-dev-update-light@2x.png": "views/assets/tray-icon-dev-update-light@2x.png",
			"assets/tray-icon-dev-update-dark@2x.png": "views/assets/tray-icon-dev-update-dark@2x.png",
			"build-seed": "seed",
			// The toolbelt CLI and stdio MCP shim (docs/agents.md), run with the bundled Bun.
			"build-cli/toolbelt.js": "cli/toolbelt.js",
		},
		watchIgnore: ["dist/**", "build-seed/**", "build-cli/**"],
		mac: {
			bundleCEF: false,
			// bun run icons (Running's official/dev artwork)
			icons: variant.icons,
		},
	},
	scripts: { postBuild: "./scripts/post-build.ts" },
	runtime: {
		// A menu bar app: closing the window doesn't quit.
		exitOnLastWindowClosed: false,
	},
} satisfies ElectrobunConfig;
