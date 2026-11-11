import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import Popover from "./Popover";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setTheme } from "@/lib/theme";
import { useSettings } from "@/lib/store";

/** Keeps this view's colors in step with ToolBelt's appearance settings. */
function ThemeSync() {
	const [settings] = useSettings();
	useEffect(() => {
		if (settings) setTheme(settings.theme, settings.mode);
	}, [settings?.theme, settings?.mode]);
	return null;
}

const isPopover = location.hash === "#popover";
document.documentElement.dataset.surface = isPopover ? "popover" : "window";

// No web-page right-click menu (Back, Reload, Inspect Element) — this is an app. It stays where
// it's useful: in text fields (cut, copy, paste) and on selected text (copy, look up).
document.addEventListener("contextmenu", (e) => {
	const editable = (e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable=true]");
	const selected = !!window.getSelection()?.toString().trim();
	if (!editable && !selected) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<TooltipProvider delayDuration={400}>
			<ThemeSync />
			{isPopover ? <Popover /> : <App />}
			{!isPopover && <Toaster position="bottom-right" />}
		</TooltipProvider>
	</StrictMode>,
);
