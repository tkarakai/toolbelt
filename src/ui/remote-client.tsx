// What a browser view adds on top of the app (docs/remote-access.md): the connection banner, the
// home-screen badge, the service worker and help installing to the home screen. Inside the app
// none of this renders.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Bell, Copy, Ellipsis, EllipsisVertical, KeyRound, Loader2, Menu, PowerOff, RefreshCw, Share, SquarePlus, Unplug, WifiOff, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pairDevice, usePlugins, useConnection, useSettings } from "@/lib/store";
import { inApp, remoteClient } from "@/lib/device";
import { INSTALL_PARAM, installContext, installHelp, installTitle, stepSegments, stepText, type InstallStep } from "@/lib/install";
import { badgeTotal, PAIR_PARAM } from "../shared/remote";

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
	if (status === "unpaired") return <PairingScreen />;
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
	// Remote access turned off won't fix itself: it gets the alarming red; the rest stays calm.
	const off = status === "off";
	return (
		<div
			role={off ? "alert" : "status"}
			className={cn(
				"fixed inset-x-0 top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm shadow-sm animate-in fade-in-0 slide-in-from-top-2 duration-200",
				off ? "border-red-800 bg-red-600 font-medium text-white dark:bg-red-700" : "bg-card/95 backdrop-blur",
			)}
			style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
		>
			{off ? <PowerOff className="size-4 shrink-0" aria-hidden="true" /> : <WifiOff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
			<span>{text}</span>
			{status !== "connecting" && (
				<Button size="sm" variant="outline" className={cn(off && "border-white/60 bg-transparent text-white hover:bg-white/15 hover:text-white dark:bg-transparent")} onClick={reconnect}>
					Retry now
				</Button>
			)}
		</div>
	);
}

// ── pairing (docs/remote-access.md, "Pairing") ─────────────────────────────────

/**
 * This browser isn't paired with the Mac. Arriving from the pairing QR code pairs by itself;
 * otherwise the person types the six digits the Mac shows.
 */
function PairingScreen() {
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pairing, setPairing] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const pair = async (secret: string) => {
		setPairing(true);
		setError(null);
		try {
			await pairDevice(secret);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setCode("");
			setPairing(false);
			requestAnimationFrame(() => input.current?.focus());
		}
	};
	useEffect(() => {
		if (!arrivalSecret) return;
		const secret = arrivalSecret;
		arrivalSecret = null;
		void pair(secret);
	}, []);
	const change = (value: string) => {
		const digits = value.replace(/\D/g, "").slice(0, 6);
		setCode(digits);
		if (digits.length === 6) void pair(digits);
	};
	return (
		<div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-background p-4 animate-in fade-in-0 duration-200" role="dialog" aria-modal="true" aria-labelledby="tb-pair-title" aria-describedby="tb-pair-text">
			<form className="w-full max-w-sm space-y-5 rounded-xl border bg-card p-6 text-center shadow-lg" onSubmit={(e) => (e.preventDefault(), code.length === 6 && void pair(code))}>
				<KeyRound className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
				<div className="space-y-2">
					<h2 id="tb-pair-title" className="text-base font-semibold">Pair with your Mac</h2>
					<p id="tb-pair-text" className="text-sm text-muted-foreground">
						On your Mac, open ToolBelt’s <strong className="font-semibold text-foreground">Settings → Remote Access</strong>, choose <strong className="font-semibold text-foreground">Pair a device</strong>, then <strong className="font-semibold text-foreground">Type a code instead</strong>. Enter the six digits it shows.
					</p>
				</div>
				<Input
					ref={input}
					value={code}
					onChange={(e) => change(e.target.value)}
					inputMode="numeric"
					autoComplete="one-time-code"
					autoFocus
					maxLength={7}
					placeholder="000000"
					aria-label="Pairing code"
					aria-invalid={!!error}
					aria-describedby={error ? "tb-pair-error" : undefined}
					disabled={pairing}
					className="mx-auto h-12 w-44 text-center font-mono text-2xl tracking-[0.3em]"
				/>
				{error && <p id="tb-pair-error" role="alert" className="text-sm text-destructive">{error}</p>}
				<Button type="submit" className="w-full" disabled={pairing || code.length !== 6}>
					{pairing && <Loader2 className="animate-spin" />}
					{pairing ? "Pairing…" : "Pair"}
				</Button>
				<p className="text-xs text-muted-foreground">In a browser, scanning the QR code on your Mac with the camera pairs too.</p>
			</form>
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
/** The pairing QR code's one-time secret (`#pair=…`), used once to pair on arrival. */
let arrivalSecret: string | null = null;

/**
 * Called once at startup in a browser: keeps Chromium's install prompt for our own button, and
 * notes whether the QR code asked for install help (removing the parameter from the address).
 */
export function captureInstallPrompt() {
	if (inApp) return;
	const url = new URL(location.href);
	// Runs before the hash router reads the address: `#pair=…` is the QR code's, not a route.
	const pairing = new URLSearchParams(url.hash.slice(1)).get(PAIR_PARAM);
	if (url.searchParams.has(INSTALL_PARAM) || pairing) {
		askedOnArrival = url.searchParams.has(INSTALL_PARAM);
		// The secret leaves the address bar (and history) at once; it's good for one pairing window.
		arrivalSecret = pairing;
		url.searchParams.delete(INSTALL_PARAM);
		if (pairing) url.hash = "";
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

const STEP_ICONS = { share: Share, more: Ellipsis, dots: EllipsisVertical, menu: Menu, add: SquarePlus };

/** A step's text: what to tap as a button-like chip (with the icon people look for), emphasis in bold. */
export function StepText({ text }: { text: string }) {
	return (
		<>
			{stepSegments(text).map((segment, i) => {
				if (segment.kind === "text") return <span key={i}>{segment.text}</span>;
				if (segment.kind === "strong") return <strong key={i} className="font-semibold">{segment.text}</strong>;
				const Icon = segment.icon ? STEP_ICONS[segment.icon] : null;
				return (
					<span key={i} className="mx-0.5 inline-flex items-center gap-1 whitespace-nowrap rounded-md border bg-background px-1.5 py-0.5 align-middle text-[0.8125rem] font-semibold leading-none shadow-xs">
						{Icon && <Icon className="size-3.5" aria-hidden="true" />}
						{segment.label}
					</span>
				);
			})}
		</>
	);
}

/** Numbered install steps; a hint under a step covers where people get stuck. */
export function InstallSteps({ steps }: { steps: InstallStep[] }) {
	return (
		<ol className="space-y-3 text-sm">
			{steps.map((step, i) => (
				<li key={step.text} className="flex gap-3">
					<span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold tabular-nums text-primary-foreground" aria-hidden="true">{i + 1}</span>
					<div className="min-w-0 space-y-1 leading-6">
						<p aria-label={stepText(step.text)}><StepText text={step.text} /></p>
						{step.hint && <p className="text-xs leading-5 text-muted-foreground"><StepText text={step.hint} /></p>}
					</div>
				</li>
			))}
		</ol>
	);
}

/** For browsers that can't install: the address, to paste into Safari. */
export function CopyAddressButton() {
	const copy = async () => {
		// With `?install`, Safari shows the steps as soon as the page opens.
		const url = new URL(location.href);
		url.hash = "";
		url.search = `?${INSTALL_PARAM}`;
		try {
			await navigator.clipboard.writeText(url.href);
			toast.success("Address copied: paste it into Safari");
		} catch {
			toast.error("Couldn’t copy. Copy it from the address bar instead.");
		}
	};
	return (
		<Button size="sm" onClick={() => void copy()}>
			<Copy />
			Copy address
		</Button>
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
			<p className="text-sm text-muted-foreground">
				{help.kind === "steps" && help.copyAddress && help.note ? <StepText text={help.note} /> : "It then opens like an app: full screen, one tap from your home screen."}
			</p>
			{help.kind === "prompt" ? (
				<div className="flex justify-end gap-2">
					<Button variant="outline" size="sm" onClick={close}>Not now</Button>
					<Button size="sm" onClick={() => void install.prompt().then((accepted) => accepted && setClosed(true))}>
						<SquarePlus />
						Install ToolBelt
					</Button>
				</div>
			) : (
				<>
					<InstallSteps steps={help.steps} />
					{help.note && !help.copyAddress && <p className="text-xs text-muted-foreground"><StepText text={help.note} /></p>}
					<div className="flex justify-end gap-2">
						{help.copyAddress && <CopyAddressButton />}
						<Button variant={help.copyAddress ? "outline" : "default"} size="sm" onClick={close}>Got it</Button>
					</div>
				</>
			)}
		</Card>
	);
}
