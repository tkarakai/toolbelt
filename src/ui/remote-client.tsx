// What a browser view adds on top of the app (docs/remote-access.md): the connection banner, the
// home-screen badge, the service worker and help installing to the home screen. Inside the app
// none of this renders.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Bell, EllipsisVertical, RefreshCw, Share, SquarePlus, Unplug, WifiOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePlugins, useConnection, useSettings } from "@/lib/store";
import { inApp, remoteClient } from "@/lib/device";
import { INSTALL_PARAM, installContext, installHelp, installTitle, type InstallStep } from "@/lib/install";
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

// ── installing to the home screen ───────────────────────────────────────────

type InstallPromptEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
let deferredPrompt: InstallPromptEvent | null = null;
let justInstalled = false;
const installListeners = new Set<() => void>();
const notifyInstall = () => installListeners.forEach((l) => l());

/** The page arrived from the Mac's QR code (`?install`): show install help right away. */
let askedOnArrival = false;

/**
 * Called once at startup in a browser: keeps Chromium's install prompt for our own button, and
 * notes whether the QR code asked for install help (removing the parameter from the address).
 */
export function captureInstallPrompt() {
	if (inApp) return;
	const url = new URL(location.href);
	if (url.searchParams.has(INSTALL_PARAM)) {
		askedOnArrival = true;
		url.searchParams.delete(INSTALL_PARAM);
		history.replaceState(history.state, "", url.pathname + url.search + url.hash);
	}
	window.addEventListener("beforeinstallprompt", (event) => {
		event.preventDefault();
		deferredPrompt = event as InstallPromptEvent;
		notifyInstall();
	});
	window.addEventListener("appinstalled", () => {
		justInstalled = true;
		deferredPrompt = null;
		notifyInstall();
	});
	matchMedia("(display-mode: standalone)").addEventListener?.("change", notifyInstall);
}

const standalone = () =>
	matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** This device's install situation and what to offer. */
export function useInstall() {
	const version = useSyncExternalStore(
		(l) => {
			installListeners.add(l);
			return () => void installListeners.delete(l);
		},
		() => `${!!deferredPrompt}:${justInstalled}:${standalone()}`,
	);
	const context = installContext(navigator.userAgent, navigator.maxTouchPoints);
	const installed = standalone() || justInstalled;
	return {
		version,
		context,
		installed,
		standalone: standalone(),
		help: installHelp(context, installed, !!deferredPrompt),
		/** Opens the browser's install dialog; true when the person accepted. */
		async prompt() {
			const event = deferredPrompt;
			if (!event) return false;
			deferredPrompt = null;
			await event.prompt();
			const { outcome } = await event.userChoice;
			notifyInstall();
			return outcome === "accepted";
		},
	};
}

// Per-device conveniences: browser storage may be unavailable; then the cards just show again.
const remembered = (key: string) => {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
};
const remember = (key: string) => {
	try {
		localStorage.setItem(key, "1");
	} catch {
		// Not kept: fine.
	}
};
const INSTALL_DISMISSED = "toolbelt.install-dismissed";
const BADGE_OFFER_DISMISSED = "toolbelt.badge-offer-dismissed";

const STEP_ICONS = { share: Share, menu: EllipsisVertical, plus: SquarePlus };

/** Numbered install steps, with the icon the person looks for. */
export function InstallSteps({ steps }: { steps: InstallStep[] }) {
	return (
		<ol className="space-y-2 text-sm">
			{steps.map((step, i) => {
				const Icon = step.icon ? STEP_ICONS[step.icon] : null;
				return (
					<li key={step.text} className="flex items-center gap-2.5">
						<span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium tabular-nums" aria-hidden="true">{i + 1}</span>
						<span className="min-w-0">{step.text}</span>
						{Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
					</li>
				);
			})}
		</ol>
	);
}

function Card({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
	return (
		<section
			aria-label={title}
			className="fixed inset-x-3 bottom-3 z-40 mx-auto max-w-md space-y-3 rounded-xl border bg-card p-4 shadow-lg animate-in fade-in-0 slide-in-from-bottom-2 duration-200"
			style={{ marginBottom: "env(safe-area-inset-bottom)" }}
		>
			<div className="flex items-start gap-3">
				<img src="./pwa/icon-180.png" alt="" className="size-10 shrink-0 rounded-[22%]" onError={(e) => (e.currentTarget.style.display = "none")} />
				<h2 className="min-w-0 flex-1 self-center text-sm font-semibold">{title}</h2>
				<Button variant="ghost" size="icon-sm" className="-mr-1 -mt-1 shrink-0 text-muted-foreground" onClick={onClose} aria-label="Close">
					<X />
				</Button>
			</div>
			{children}
		</section>
	);
}

/**
 * On a phone or tablet browser: how to put ToolBelt on the home screen, once (or whenever the
 * QR code asks). After installing, the first launch offers the home-screen badge.
 */
export function InstallCard() {
	const install = useInstall();
	const [settings] = useSettings();
	const [closed, setClosed] = useState(() => !askedOnArrival && remembered(INSTALL_DISMISSED));
	const [badgeClosed, setBadgeClosed] = useState(() => remembered(BADGE_OFFER_DISMISSED));
	const [permission, setPermission] = useState(badgePermission);
	const { help, context } = install;
	if (inApp || context.device === "desktop") return null;

	if (install.standalone && !badgeClosed && badgeSupported() && permission === "default" && settings?.badgePlugins.length)
		return (
			<Card title="Show a badge on ToolBelt’s icon?" onClose={() => (remember(BADGE_OFFER_DISMISSED), setBadgeClosed(true))}>
				<p className="text-sm text-muted-foreground">Your Mac’s Remote Access settings total some plugins’ badges on the icon. iOS asks to allow notifications for that; ToolBelt never sends any.</p>
				<div className="flex justify-end gap-2">
					<Button variant="outline" size="sm" onClick={() => (remember(BADGE_OFFER_DISMISSED), setBadgeClosed(true))}>Not now</Button>
					<Button size="sm" onClick={() => void Notification.requestPermission().then((p) => (setPermission(p), remember(BADGE_OFFER_DISMISSED)))}>
						<Bell />
						Allow badge
					</Button>
				</div>
			</Card>
		);

	if (closed || help.kind === "none") return null;
	const close = () => (remember(INSTALL_DISMISSED), setClosed(true));
	return (
		<Card title={installTitle(context)} onClose={close}>
			{help.kind === "prompt" ? (
				<>
					<p className="text-sm text-muted-foreground">Open ToolBelt from your home screen like an app, full screen and quick to start.</p>
					<div className="flex justify-end gap-2">
						<Button variant="outline" size="sm" onClick={close}>Not now</Button>
						<Button size="sm" onClick={() => void install.prompt().then((accepted) => accepted && setClosed(true))}>
							<SquarePlus />
							Install ToolBelt
						</Button>
					</div>
				</>
			) : (
				<>
					<InstallSteps steps={help.steps} />
					{help.note && <p className="text-xs text-muted-foreground">{help.note}</p>}
				</>
			)}
		</Card>
	);
}
