import "./scripts/settings-build-info.ts";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite.ts";

// One web app for both surfaces: the main window (index.html) and the menu bar popover
// (index.html#popover). Electrobun serves the build from views://ui/.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: [...electrobunViteAliases(resolve(import.meta.dirname, ".hutch/devkit")), { find: /^@\//, replacement: resolve(import.meta.dirname, "src/ui") + "/" }],
	},
	root: "src/ui",
	base: "./",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
		// Local files, no network: one bundle (it includes every lucide icon plugins may name).
		chunkSizeWarningLimit: 2000,
	},
	server: {
		port: 5173,
		strictPort: true,
	},
});
