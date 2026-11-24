// What a browser view adds on top of the app (docs/remote-access.md): the connection banner, the
// home-screen badge and the service worker. Inside the app none of this renders.
import { useEffect, useState } from "react";
import { RefreshCw, Unplug, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePlugins, useConnection, useSettings } from "@/lib/store";
import { inApp, remoteClient } from "@/lib/device";
import { badgeTotal } from "../shared/remote";

/** Registers the service worker that caches the app shell (remote devices only). */
export function registerServiceWorker() {
	if (!remoteClient || !isSecureContext || !("serviceWorker" in navigator)) return;
	void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((error) => console.warn("service worker:", error));
}

/** Whether this device can show a badge on ToolBelt's home-screen icon. */
export const badgeSupported = () => remoteClient && "setAppBadge" in navigator;

/** iOS shows badges only with notification permission; no notification is ever sent. */
export const badgePermission = (): NotificationPermission | "unsupported" =>
	typeof Notification === "undefined" ? "unsupported" : Notification.permission;

/** Keeps the home-screen badge at the total of the chosen plugins' badges. */
export function BadgeSync() {
	const plugins = usePlugins();
	const [settings] = useSettings();
	useEffect(() => {
		if (!badgeSupported() || !settings) return;
		if (badgePermission() !== "granted" && badgePermission() !== "unsupported") return;
		const total = badgeTotal(plugins, settings.badgePlugins);
		const nav = navigator as Navigator & { setAppBadge(n?: number): Promise<void>; clearAppBadge(): Promise<void> };
		void (total === null ? nav.clearAppBadge() : total === "dot" ? nav.setAppBadge() : nav.setAppBadge(total)).catch(() => {});
	}, [plugins, settings]);
	return null;
}

/** Shows when the browser connection to the Mac isn't live. */
export function ConnectionBanner() {
	const [status, reconnect] = useConnection();
	// The first connection usually takes a moment; don't flash a banner for it.
	const [late, setLate] = useState(false);
	useEffect(() => {
		if (status !== "connecting") return setLate(false);
		const timer = setTimeout(() => setLate(true), 800);
		return () => clearTimeout(timer);
	}, [status]);
	if (inApp || status === "open" || (status === "connecting" && !late)) return null;
	if (status === "disconnected")
		return (
			<div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm animate-in fade-in-0 duration-200" role="alertdialog" aria-labelledby="tb-disconnected-title" aria-describedby="tb-disconnected-text">
				<div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 text-center shadow-lg animate-in fade-in-0 zoom-in-95 duration-200">
					<Unplug className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
					<div className="space-y-1">
						<h2 id="tb-disconnected-title" className="text-base font-semibold">Disconnected from your Mac</h2>
						<p id="tb-disconnected-text" className="text-sm text-muted-foreground">This device was disconnected in ToolBelt’s Remote Access settings.</p>
					</div>
					<Button autoFocus onClick={reconnect}>
						<RefreshCw />
						Reconnect
					</Button>
				</div>
			</div>
		);
	const text =
		status === "off"
			? "Remote access is turned off on your Mac."
			: status === "connecting"
				? "Connecting to your Mac…"
				: "Can’t reach your Mac. Retrying…";
	return (
		<div role="status" className="fixed inset-x-0 top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b bg-card/95 px-4 py-2 text-sm shadow-sm backdrop-blur animate-in fade-in-0 slide-in-from-top-2 duration-200" style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}>
			<WifiOff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			<span>{text}</span>
			{status !== "connecting" && (
				<Button size="sm" variant="outline" onClick={reconnect}>
					Retry now
				</Button>
			)}
		</div>
	);
}
