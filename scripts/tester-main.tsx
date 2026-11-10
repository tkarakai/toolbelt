import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import Tester from "../src/ui/Tester";
import { rpc, useSettings } from "../src/ui/lib/store";
import { setTheme } from "../src/ui/lib/theme";
import { Toaster } from "../src/ui/components/ui/sonner";
import { TooltipProvider } from "../src/ui/components/ui/tooltip";
import "../src/ui/index.css";
function Theme(){const [s]=useSettings();useEffect(()=>{if(s)setTheme(s.theme,s.mode);},[s]);return null;}
const control = (operation:string,params={}) => (rpc.request as any).tester({operation,...params});
document.documentElement.dataset.surface="window";
createRoot(document.getElementById("root")!).render(<StrictMode><TooltipProvider><Theme/><Tester control={control}/><Toaster/></TooltipProvider></StrictMode>);
