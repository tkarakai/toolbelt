import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import Popover from "./Popover";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

// Follow the system appearance.
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

const isPopover = location.hash === "#popover";
document.documentElement.dataset.surface = isPopover ? "popover" : "window";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<TooltipProvider delayDuration={400}>
			{isPopover ? <Popover /> : <App />}
			{!isPopover && <Toaster position="bottom-right" />}
		</TooltipProvider>
	</StrictMode>,
);
