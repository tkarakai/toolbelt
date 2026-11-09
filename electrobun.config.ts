import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json" with { type: "json" };

export default {
	app: {
		name: "Toolbelt",
		identifier: "io.github.tkarakai.toolbelt",
		version: pkg.version,
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		// Vite builds the web app to dist/; built-in plugins are bundled to build-plugins/.
		copy: {
			"dist/index.html": "views/ui/index.html",
			"dist/assets": "views/ui/assets",
			"assets/tray-icon@2x.png": "views/assets/tray-icon@2x.png",
			"build-plugins": "plugins",
		},
		watchIgnore: ["dist/**", "build-plugins/**"],
		mac: {
			bundleCEF: false,
			// bun scripts/make-app-icon.ts
			icons: "icon.iconset",
		},
	},
	runtime: {
		// A menu bar app: closing the window doesn't quit.
		exitOnLastWindowClosed: false,
	},
} satisfies ElectrobunConfig;
