import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json" with { type: "json" };

import { appVariant } from "./src/shared/variant";
const variant = appVariant(process.env.TOOLBELT_VARIANT === "dev");

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
			"assets/tray-icon-dev@2x.png": "views/assets/tray-icon-dev@2x.png",
			"assets/tray-icon@2x.png": "views/assets/tray-icon@2x.png",
			// With a red dot, when an update is available (scripts/make-icons.ts).
			"assets/tray-icon-update-light@2x.png": "views/assets/tray-icon-update-light@2x.png",
			"assets/tray-icon-update-dark@2x.png": "views/assets/tray-icon-update-dark@2x.png",
			"build-plugins": "plugins",
		},
		watchIgnore: ["dist/**", "build-plugins/**"],
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
