import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import Popover from "./Popover";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setTheme } from "@/lib/theme";
import { useSettings } from "@/lib/store";

/** Keeps this view's colors in step with Toolbelt's appearance settings. */
function ThemeSync() {
	const [settings] = useSettings();
	useEffect(() => {
		if (settings) setTheme(settings.theme, settings.mode);
	}, [settings?.theme, settings?.mode]);
	return null;
}

const isPopover = location.hash === "#popover";
document.documentElement.dataset.surface = isPopover ? "popover" : "window";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<TooltipProvider delayDuration={400}>
			<ThemeSync />
			{isPopover ? <Popover /> : <App />}
			{!isPopover && <Toaster position="bottom-right" />}
		</TooltipProvider>
	</StrictMode>,
);
