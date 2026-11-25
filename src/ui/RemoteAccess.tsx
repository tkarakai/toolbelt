// Settings → Remote Access (docs/remote-access.md): serve ToolBelt to the owner's other devices
// through Tailscale. The switch, Tailscale's status, the Serve rule, the address, paired devices
// and the pairing dialog (code and QR code), the home-screen badge and the connected devices.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import qrcode from "qrcode-generator";
import { AlertTriangle, Check, ChevronDown, ChevronLeft, CircleHelp, Copy, ExternalLink, KeyRound, Laptop, Loader2, MoreHorizontal, RefreshCw, Smartphone, Tablet, Trash2, Unplug } from "lucide-react";
import { Switch } from "./components/ui/switch";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { SettingsGroup, SettingsRow } from "./components/settings-layout";
import { remoteAccessRequest, thisDevice, usePlugins, useRemoteAccess, openUrl } from "./lib/store";
import { inApp, remoteClient } from "./lib/device";
import { badgePermission, badgeSupported, CopyAddressButton, InstallSteps, StepText, useInstall } from "./remote-client";
import { pillClass, textClass } from "./renderer/colors";
import { cn } from "./lib/utils";
import { pairingLink, validPort, type PairedDevice, type RemoteAccessRequest, type RemoteAccessState, type RemoteConnection } from "../shared/remote";

const ADMIN_DNS = "https://login.tailscale.com/admin/dns";
const ADMIN_MACHINES = "https://login.tailscale.com/admin/machines";
/** Shown in confirmations made from a remote device that would cut its own connection. */
const LOCKOUT = "You’re using ToolBelt from this device. It loses access until remote access is set up again at the Mac.";

type Confirmation = {
	title: string;
	body: ReactNode;
	confirm: string;
	destructive?: boolean;
	/** A second choice beside the main one (port change without moving the rule). */
	alternative?: { label: string; request: RemoteAccessRequest };
	request: RemoteAccessRequest;
};

async function run(request: RemoteAccessRequest, success?: string) {
	try {
		const state = await remoteAccessRequest(request);
		if (state.lastError) toast.error(state.lastError);
		else if (success) toast.success(success);
		return state;
	} catch (error) {
		toast.error(error instanceof Error ? error.message : String(error));
		return null;
	}
}

export function RemoteAccessSettings() {
	const state = useRemoteAccess();
	const [confirming, setConfirming] = useState<Confirmation | null>(null);
	if (!state) return <p className="px-1 text-sm text-muted-foreground">Reading remote access…</p>;
	return (
		<div className="space-y-8">
			{!inApp && <ThisDeviceGroup />}
			<AccessGroup state={state} confirm={setConfirming} />
			<DevicesGroup state={state} confirm={setConfirming} />
			<BadgeGroup state={state} />
			{/* Setup details: needed once, so they come last. */}
			<TailscaleGroup state={state} confirm={setConfirming} />
			<ConfirmDialog confirmation={confirming} close={() => setConfirming(null)} />
		</div>
	);
}

function AccessGroup({ state, confirm }: { state: RemoteAccessState; confirm: (c: Confirmation) => void }) {
	const { enabled } = state.settings;
	const toggle = (next: boolean) => {
		if (!next && remoteClient)
			return confirm({
				title: "Turn off remote access?",
				body: <>Every remote device disconnects. {LOCKOUT}</>,
				confirm: "Turn off",
				destructive: true,
				request: { operation: "setEnabled", enabled: false },
			});
		void run({ operation: "setEnabled", enabled: next });
	};
	return (
		<SettingsGroup title="Remote access" description="Use ToolBelt and its plugins from your phone or tablet. Plugins keep running on this Mac; the other device is just another screen. Only devices signed in to your Tailscale account can connect.">
			<SettingsRow
				title="Serve ToolBelt to your devices"
				description={
					state.serverError ? (
						<span className="text-destructive">{state.serverError}</span>
					) : state.running ? (
						<>Listening on this Mac at port <span className="font-mono">{state.settings.port}</span>, for Tailscale only.</>
					) : (
						"Off: nothing listens for remote devices."
					)
				}
			>
				<Switch checked={enabled} onCheckedChange={toggle} aria-label="Remote access" disabled={state.busy !== null} />
			</SettingsRow>
			{enabled && state.url && state.rule.state === "ours" && <AddressRow url={state.url} reachable={state.reachable} />}
			<PortRow state={state} confirm={confirm} />
		</SettingsGroup>
	);
}

function AddressRow({ url, reachable }: { url: string; reachable: RemoteAccessState["reachable"] }) {
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(url);
			toast.success("Address copied");
		} catch {
			toast.error("Couldn’t copy the address");
		}
	};
	return (
		<SettingsRow
			title="Address"
			description={
				<>
					<span className="block break-all font-mono text-foreground">{url}</span>
					Devices pair once before they can use it: see Devices.
					{reachable === "no" && <span className="text-destructive"> The address doesn’t answer yet; see Tailscale below.</span>}
				</>
			}
		>
			<Button size="sm" variant="outline" onClick={() => void copy()}>
				<Copy />
				Copy address
			</Button>
		</SettingsRow>
	);
}

/** On a phone or tablet: whether ToolBelt is on its home screen, and how to put it there. */
function ThisDeviceGroup() {
	const install = useInstall();
	const { help, context } = install;
	if (context.device === "desktop") return null;
	return (
		<SettingsGroup title="This device">
			{install.installed ? (
				<SettingsRow title="Home screen" description="ToolBelt is installed on this device’s home screen." />
			) : help.kind === "prompt" ? (
				<SettingsRow title="Home screen" description="Install ToolBelt to open it like an app: full screen, one tap from your home screen.">
					<Button size="sm" onClick={() => void install.prompt()}>Install ToolBelt</Button>
				</SettingsRow>
			) : help.kind === "steps" ? (
				<div className="space-y-3 px-5 py-4">
					<h3 className="text-sm font-medium">Add ToolBelt to the home screen</h3>
					<InstallSteps steps={help.steps} />
					{help.note && <p className="text-xs text-muted-foreground"><StepText text={help.note} /></p>}
					{help.copyAddress && <CopyAddressButton />}
				</div>
			) : null}
		</SettingsGroup>
	);
}

function qrSvg(text: string, size = 148) {
	const qr = qrcode(0, "M");
	qr.addData(text);
	qr.make();
	const n = qr.getModuleCount();
	let path = "";
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" width="${size}" height="${size}" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
}

// ── pairing (docs/remote-access.md, "Pairing") ─────────────────────────────────

/**
 * Paired devices, the only ones that can connect, connected ones first with their live
 * connection: path, round trip and data use. One row per browser or home-screen app.
 */
function DevicesGroup({ state, confirm }: { state: RemoteAccessState; confirm: (c: Confirmation) => void }) {
	const [open, setOpen] = useState(false);
	const ready = state.running && !!state.url && state.rule.state === "ours";
	const start = async () => {
		if (await run({ operation: "startPairing" })) setOpen(true);
	};
	const close = () => {
		setOpen(false);
		void run({ operation: "stopPairing" });
	};
	const me = thisDevice()?.id;
	const revoke = (device: PairedDevice) =>
		confirm({
			title: `Remove ${device.name}?`,
			body: <>It disconnects and has to pair again to use ToolBelt.{device.id === me && <> {LOCKOUT}</>}</>,
			confirm: "Remove",
			destructive: true,
			request: { operation: "revoke", id: device.id },
		});
	return (
		<SettingsGroup
			title="Devices"
			description="Besides being signed in to your Tailscale account, each phone, tablet or browser pairs once, approved here on the Mac or from a device that’s already paired. A home-screen app pairs separately from its browser. Disconnect ends a session; Remove takes the approval back."
			actions={
				<Button size="sm" disabled={!ready} onClick={() => void start()} title={ready ? undefined : "Turn on remote access and create the Tailscale rule first"}>
					<KeyRound />
					Pair a device
				</Button>
			}
		>
			{state.paired.length ? (
				state.paired.map((device) => <DeviceRow key={device.id} device={device} me={device.id === me} revoke={() => revoke(device)} />)
			) : (
				<div className="px-5 py-4 text-sm text-muted-foreground">No paired devices yet. {ready ? "Choose Pair a device and scan its code with your phone." : "Pairing needs remote access on and the Tailscale rule."}</div>
			)}
			<PairDialog state={state} open={open} close={close} />
		</SettingsGroup>
	);
}

/** A phone, tablet or computer, from Tailscale's OS while connected, else the device's name. */
function DeviceIcon({ device }: { device: PairedDevice }) {
	const os = device.live?.os?.toLowerCase() ?? "";
	const Icon = /ipad|tablet/i.test(device.name)
		? Tablet
		: /macos|windows|linux/.test(os) || /\((web app|browser)\)/i.test(device.name)
			? Laptop
			: Smartphone;
	return (
		<span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", device.live ? "bg-selected text-selected-foreground" : "bg-muted text-muted-foreground")}>
			<Icon className="size-4" aria-hidden="true" />
		</span>
	);
}

/**
 * One paired device: what it is and whether it's connected, at any width. Actions sit in a menu
 * so nothing wraps on a phone; the connection's numbers open on request.
 */
function DeviceRow({ device, me, revoke }: { device: PairedDevice; me: boolean; revoke: () => void }) {
	const live = device.live;
	const [details, setDetails] = useState(false);
	const relayed = live?.path?.startsWith("relay");
	const detailsId = `device-details-${device.id}`;
	return (
		<div className="px-4 py-3 sm:px-5 animate-in fade-in-0 duration-300">
			<div className="flex items-start gap-3">
				<DeviceIcon device={device} />
				<div className="min-w-0 flex-1 space-y-1 pt-0.5">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span className="min-w-0 text-sm font-medium break-words">{device.name}</span>
						{me && <span className={cn("rounded-full px-2 py-0.5 text-xs", pillClass("default"))}>This device</span>}
					</div>
					{live ? (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
							<span className={cn("inline-flex items-center gap-1.5 font-medium", textClass("success"))}>
								<span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
								Connected
							</span>
							{live.path && (
								<span className={cn(relayed && textClass("warning"))} title={relayed ? "Tailscale can’t connect directly and relays this device’s traffic, which is slower." : undefined}>
									{live.path === "direct" ? "Direct" : live.path.replace(/^relay/, "Relayed via")}
								</span>
							)}
							{live.rtt !== null && <span className="tabular-nums">{live.rtt} ms</span>}
							<button
								type="button"
								className="inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-ring"
								aria-expanded={details}
								aria-controls={detailsId}
								onClick={() => setDetails(!details)}
							>
								Details
								<ChevronDown className={cn("size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none", details && "rotate-180")} aria-hidden="true" />
							</button>
						</div>
					) : (
						<div className="text-xs text-muted-foreground">Last used {since(device.lastSeen)}</div>
					)}
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon-sm" className="-mr-1 shrink-0 text-muted-foreground" aria-label={`Actions for ${device.name}`}>
							<MoreHorizontal />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-48">
						{live && (
							<DropdownMenuItem onSelect={() => void run({ operation: "disconnect", id: device.id }, `${device.name} disconnected`)}>
								<Unplug />
								Disconnect
							</DropdownMenuItem>
						)}
						{live && <DropdownMenuSeparator />}
						<DropdownMenuItem variant="destructive" onSelect={revoke}>
							<Trash2 />
							Remove…
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{live && (
				<div id={detailsId} className={cn("grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none", details ? "grid-rows-[1fr]" : "grid-rows-[0fr]")} inert={!details}>
					<div className="overflow-hidden">
						<ConnectionStats device={device} live={live} />
					</div>
				</div>
			)}
		</div>
	);
}

function ConnectionStats({ device, live }: { device: PairedDevice; live: RemoteConnection }) {
	const stat = (label: string, value: ReactNode) => (
		<div className="min-w-0">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="text-xs tabular-nums break-words">{value}</dd>
		</div>
	);
	return (
		<dl className="mt-3 ml-12 grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-lg bg-muted/50 p-3 sm:grid-cols-4">
			{stat("Connected", since(live.connectedAt))}
			{stat("Tailnet address", live.ip ?? "—")}
			{stat("System", live.os ?? "—")}
			{stat("Windows", live.connections)}
			{stat("Sent", <>{bytes(live.bytesOut)} <span className="text-muted-foreground">(≈{bytes(live.wireOut)} compressed)</span></>)}
			{stat("Received", bytes(live.bytesIn))}
			{stat("Screens sent", <>{live.treesSent.toLocaleString()}{live.treesSkipped > 0 && <span className="text-muted-foreground">, {live.treesSkipped.toLocaleString()} stale skipped</span>}</>)}
			{stat("Paired", day(device.pairedAt))}
		</dl>
	);
}

/** Seconds left, ticking while shown. */
function useRemaining(until: number | null) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (until === null) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [until]);
	return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1_000));
}

/**
 * Pairing: scanning the QR code is the whole job, so that's all the dialog shows at first. Typing
 * a code (a device that can't scan, or the home-screen app, which pairs separately) is a second
 * view the person asks for, with the steps it takes. While the dialog is open an expired code
 * is replaced by itself.
 */
function PairDialog({ state, open, close }: { state: RemoteAccessState; open: boolean; close: () => void }) {
	const [view, setView] = useState<"scan" | "type">("scan");
	const pairing = state.pairing;
	const remaining = useRemaining(open && pairing ? pairing.expiresAt : null);
	const link = pairing && state.url ? pairingLink(state.url, pairing.secret) : null;
	const svg = useMemo(() => (link ? qrSvg(link, 184) : ""), [link]);
	// Expired, or ended after wrong codes: show a fresh one, once per ended pairing.
	const last = useRef<string | null>(null);
	const renewed = useRef<string | null>(null);
	if (pairing) last.current = pairing.secret;
	const ended = !pairing || remaining === 0;
	useEffect(() => {
		if (!open || !ended || renewed.current === last.current) return;
		renewed.current = last.current;
		void run({ operation: "startPairing" });
	}, [open, ended, pairing?.secret]);
	useEffect(() => {
		if (open) setView("scan");
	}, [open]);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(state.url ?? "");
			toast.success("Address copied");
		} catch {
			toast.error("Couldn’t copy the address");
		}
	};
	const live = !!pairing && !ended;
	return (
		<Dialog open={open} onOpenChange={(next) => !next && close()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{view === "scan" ? "Pair a device" : "Pair by typing a code"}</DialogTitle>
					<DialogDescription className="sr-only">
						{view === "scan" ? "Scan the QR code with the device’s camera." : "Open ToolBelt on the device, then type the code."}
					</DialogDescription>
				</DialogHeader>
				{view === "scan" ? (
					<div key="scan" className="space-y-5 animate-in fade-in-0 duration-200">
						<div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
							{/* Dark modules on white, in both themes: scanners need the contrast. */}
							<div className={cn("shrink-0 rounded-xl bg-white p-2.5 text-black shadow-sm transition-opacity duration-200", !live && "opacity-30")} role="img" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: svg }} />
							<div className="space-y-3 text-sm">
								<p className="text-base font-medium leading-snug">
									{remoteClient ? "Point the other device’s camera at the code, then tap the link that appears." : "Point your phone’s camera at the code, then tap the link that appears."}
								</p>
								<p className="text-muted-foreground">ToolBelt opens there, already paired, and shows how to add it to the home screen.</p>
							</div>
						</div>
						<PairedNow names={pairing?.paired ?? []} />
						<p className="border-t pt-4 text-sm text-muted-foreground">
							Can’t scan, or pairing ToolBelt’s home-screen app?{" "}
							<button type="button" className="font-medium text-foreground underline underline-offset-2 hover:no-underline focus-visible:outline-ring" onClick={() => setView("type")}>
								Type a code instead
							</button>
						</p>
					</div>
				) : (
					<div key="type" className="space-y-5 animate-in fade-in-0 duration-200">
						<ol className="space-y-5">
							<li className="flex gap-3">
								<StepNumber n={1} />
								<div className="min-w-0 flex-1 space-y-2 text-sm">
									<p className="font-medium">Open ToolBelt on the device.</p>
									<p className="text-muted-foreground">If it’s on the home screen, open it from there. Otherwise, open this address in the device’s browser:</p>
									<div className="flex items-center gap-2 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3">
										<span className="min-w-0 flex-1 font-mono text-xs break-all select-all">{state.url}</span>
										<Button size="sm" variant="ghost" className="shrink-0" onClick={() => void copy()}>
											<Copy />
											Copy
										</Button>
									</div>
								</div>
							</li>
							<li className="flex gap-3">
								<StepNumber n={2} />
								<div className="min-w-0 flex-1 space-y-3 text-sm">
									<p className="font-medium">When it asks for a pairing code, type:</p>
									<CodeTiles code={live ? pairing!.code : null} />
									<p className="text-xs text-muted-foreground tabular-nums" aria-live="off">
										{live ? `A new code replaces this one in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}.` : "Getting a new code…"}
									</p>
								</div>
							</li>
						</ol>
						<PairedNow names={pairing?.paired ?? []} />
						<p className="border-t pt-4 text-sm">
							<button type="button" className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline focus-visible:outline-ring" onClick={() => setView("scan")}>
								<ChevronLeft className="size-4" aria-hidden="true" />
								Back to the QR code
							</button>
						</p>
					</div>
				)}
				<DialogFooter>
					<Button autoFocus onClick={close}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function StepNumber({ n }: { n: number }) {
	return <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold tabular-nums text-primary-foreground" aria-hidden="true">{n}</span>;
}

/** The six digits as tiles, three and three, like the field the device types them into. */
function CodeTiles({ code }: { code: string | null }) {
	const digits = (code ?? "      ").split("");
	return (
		<div className="flex items-center gap-1.5" role="img" aria-label={code ? `Code ${digits.join(" ")}` : "Waiting for a code"}>
			{digits.map((digit, i) => (
				<span key={i} className={cn("grid h-12 w-10 place-items-center rounded-lg border bg-background font-mono text-2xl font-semibold tabular-nums shadow-xs", i === 3 && "ml-3")} aria-hidden="true">
					{digit.trim() || <span className="size-1.5 rounded-full bg-muted-foreground/40" />}
				</span>
			))}
		</div>
	);
}

/** Devices paired while the dialog is open, as they arrive. */
function PairedNow({ names }: { names: string[] }) {
	if (!names.length) return null;
	return (
		<ul className="space-y-1.5 text-sm" aria-live="polite">
			{names.map((name) => (
				<li key={name} className="flex items-center gap-2 animate-in fade-in-0 duration-300">
					<Check className={cn("size-4 shrink-0", textClass("success"))} aria-hidden="true" />
					<span className="min-w-0 break-words"><span className="font-medium">{name}</span> is paired</span>
				</li>
			))}
		</ul>
	);
}

function PortRow({ state, confirm }: { state: RemoteAccessState; confirm: (c: Confirmation) => void }) {
	const [value, setValue] = useState(String(state.settings.port));
	useEffect(() => setValue(String(state.settings.port)), [state.settings.port]);
	const port = Number(value);
	const valid = validPort(port);
	const changed = valid && port !== state.settings.port;
	const submit = () => {
		if (!changed) return;
		const ownRule = state.rule.state === "ours";
		if (!ownRule && !remoteClient) return void run({ operation: "setPort", port }, `Remote access now uses port ${port}`);
		confirm({
			title: `Use port ${port}?`,
			body: (
				<>
					{ownRule
						? <>The Tailscale rule forwards port {state.settings.port}. Move it: ToolBelt removes that rule and creates one for port {port} (HTTPS on tailnet port {port} → <span className="font-mono">http://127.0.0.1:{port}</span>).</>
						: <>ToolBelt listens on port {port} from now on.</>}
					{remoteClient && <> {LOCKOUT}</>}
				</>
			),
			confirm: ownRule ? "Move the rule" : "Change port",
			alternative: ownRule ? { label: "Change port only", request: { operation: "setPort", port } } : undefined,
			request: { operation: "setPort", port, moveRule: ownRule },
		});
	};
	return (
		<form className="flex flex-wrap items-end justify-between gap-4 px-5 py-4" onSubmit={(e) => (e.preventDefault(), submit())}>
			<label className="min-w-48 flex-1 space-y-1">
				<span className="block text-sm font-medium">Port</span>
				<span className="block text-sm text-muted-foreground">The same port number on this Mac and on your tailnet.</span>
			</label>
			<div className="flex items-center gap-2">
				<Input value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} inputMode="numeric" aria-label="Port" aria-invalid={!valid} className="w-28 font-mono" />
				<Button type="submit" variant="outline" disabled={!changed || state.busy !== null}>
					{state.busy === "setPort" ? <Loader2 className="animate-spin" /> : null}
					Change
				</Button>
			</div>
			{!valid && <p className="w-full text-xs text-destructive">Use a port between 1024 and 65535.</p>}
		</form>
	);
}

type Tone = "success" | "warning" | "danger" | "muted";
function StatusRow({ label, tone, value, help, children }: { label: string; tone: Tone; value: ReactNode; help?: ReactNode; children?: ReactNode }) {
	const Icon = tone === "success" ? Check : tone === "muted" ? CircleHelp : AlertTriangle;
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
			<div className="w-44 shrink-0 text-sm text-muted-foreground">{label}</div>
			<div className="min-w-0 flex-1 space-y-1 text-sm">
				<div className="flex min-w-0 items-start gap-2">
					<Icon className={cn("mt-0.5 size-4 shrink-0", textClass(tone))} aria-hidden="true" />
					<span className="min-w-0 break-words">{value}</span>
				</div>
				{help && <div className="pl-6 text-muted-foreground">{help}</div>}
			</div>
			{children && <div className="flex flex-wrap gap-2">{children}</div>}
		</div>
	);
}

function Link({ href, children }: { href: string; children: ReactNode }) {
	return (
		<button type="button" className="inline-flex items-center gap-1 underline-offset-2 hover:underline" onClick={() => openUrl(href)}>
			{children}
			<ExternalLink className="size-3" aria-hidden="true" />
		</button>
	);
}

function TailscaleGroup({ state, confirm }: { state: RemoteAccessState; confirm: (c: Confirmation) => void }) {
	const t = state.tailscale;
	const { port } = state.settings;
	const running = t.backend === "Running";
	const [refreshing, setRefreshing] = useState(false);
	const create = () =>
		confirm({
			title: "Create the Tailscale rule?",
			body: (
				<>
					<p>ToolBelt changes your Tailscale configuration:</p>
					<p className="my-2 rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">HTTPS on tailnet port {port} → http://127.0.0.1:{port}</p>
					<p>Devices on your tailnet can reach this port; ToolBelt answers only your account ({t.login}). The rule stays in Tailscale until you remove it here or in Tailscale.</p>
				</>
			),
			confirm: "Create rule",
			request: { operation: "createRule" },
		});
	const remove = () =>
		confirm({
			title: "Remove the Tailscale rule?",
			body: <>Tailscale stops forwarding port {port} to ToolBelt, and remote devices can’t reach it.{remoteClient && <> {LOCKOUT}</>}</>,
			confirm: "Remove rule",
			destructive: true,
			request: { operation: "removeRule" },
		});
	return (
		<SettingsGroup
			title="Tailscale"
			actions={
				<Button size="sm" variant="ghost" disabled={refreshing} onClick={() => (setRefreshing(true), void run({ operation: "refresh" }).finally(() => setRefreshing(false)))}>
					<RefreshCw className={cn(refreshing && "animate-spin")} />
					Refresh
				</Button>
			}
		>
			{t.cli ? (
				<StatusRow label="Command-line tool" tone="success" value={<span className="font-mono text-xs break-all">{t.cli}</span>} />
			) : (
				<StatusRow
					label="Command-line tool"
					tone="warning"
					value={t.cliError ?? "Not found"}
					help={<>Install Tailscale from tailscale.com or the App Store. ToolBelt looks on PATH, in /opt/homebrew/bin and /usr/local/bin, and inside Tailscale.app.</>}
				/>
			)}
			{t.cli && (
				<>
					<StatusRow
						label="Tailscale"
						tone={running ? "success" : "warning"}
						value={t.cliError ? t.cliError : running ? "Running" : (t.backend ?? "Unknown")}
						help={!running ? "Start Tailscale on this Mac and sign in." : undefined}
					/>
					{running && (
						<>
							<StatusRow label="Account" tone="success" value={<span className="break-all">{t.login ?? "Unknown"}</span>} help="Only this Tailscale account can connect." />
							<StatusRow label="Name" tone={t.dnsName ? "success" : "warning"} value={<span className="font-mono text-xs break-all">{t.dnsName ?? "MagicDNS is off"}</span>} help={!t.dnsName ? <>Turn on MagicDNS in the <Link href={ADMIN_DNS}>Tailscale admin console</Link>.</> : undefined} />
							<StatusRow label="HTTPS certificates" tone={t.https ? "success" : "warning"} value={t.https ? "Enabled" : "Not enabled for your tailnet"} help={!t.https ? <>Enable HTTPS certificates in the <Link href={ADMIN_DNS}>Tailscale admin console</Link>, then refresh.</> : undefined} />
							<RuleRow state={state} create={create} remove={remove} />
							{state.rule.state === "ours" && (
								<StatusRow
									label="Reachable"
									tone={state.reachable === "yes" ? "success" : state.reachable === "no" ? "danger" : "muted"}
									value={
										state.reachable === "yes"
											? "Yes: the address reaches this ToolBelt"
											: state.reachable === "checking"
												? "Checking…"
												: state.reachable === "no"
													? "No"
													: state.running
														? "Not checked yet"
														: "Turn on remote access to check"
									}
									help={state.reachable === "no" ? state.reachError : undefined}
								/>
							)}
						</>
					)}
				</>
			)}
			<div className="px-5 py-3 text-sm text-muted-foreground">
				Anyone holding an unlocked device signed in to your Tailscale account can control this Mac through ToolBelt. Use a passcode or biometric lock on every such device, turn on device approval for your tailnet, and remove a lost device in the <Link href={ADMIN_MACHINES}>Tailscale admin console</Link>.
			</div>
		</SettingsGroup>
	);
}

function RuleRow({ state, create, remove }: { state: RemoteAccessState; create: () => void; remove: () => void }) {
	const { port } = state.settings;
	const busy = state.busy === "createRule" || state.busy === "removeRule";
	const rule = state.rule;
	if (!state.tailscale.https)
		return <StatusRow label="Serve rule" tone="muted" value="Waiting for HTTPS certificates" />;
	if (rule.state === "ours")
		return (
			<StatusRow label="Serve rule" tone="success" value={<>Tailscale forwards HTTPS port {port} to ToolBelt</>}>
				<Button size="sm" variant="outline" disabled={busy || state.busy !== null} onClick={remove}>
					{state.busy === "removeRule" ? <Loader2 className="animate-spin" /> : null}
					Remove rule…
				</Button>
			</StatusRow>
		);
	if (rule.state === "conflict")
		return <StatusRow label="Serve rule" tone="danger" value={<>Port {port} already forwards to <span className="font-mono text-xs break-all">{rule.target}</span></>} help="ToolBelt never changes another rule. Choose a different port above." />;
	if (rule.state === "missing")
		return (
			<StatusRow label="Serve rule" tone="warning" value={<>No rule for port {port}</>} help="Remote devices reach ToolBelt through a Tailscale Serve rule.">
				<Button size="sm" disabled={busy || state.busy !== null} onClick={create}>
					{state.busy === "createRule" ? <Loader2 className="animate-spin" /> : null}
					Create Tailscale rule…
				</Button>
			</StatusRow>
		);
	return <StatusRow label="Serve rule" tone="muted" value="Unknown" />;
}

const bytes = (n: number) =>
	n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
const since = (at: number) => {
	const minutes = Math.round((Date.now() - at) / 60_000);
	return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
};

function BadgeGroup({ state }: { state: RemoteAccessState }) {
	const plugins = usePlugins();
	const selected = new Set(state.settings.badgePlugins);
	const [permission, setPermission] = useState(badgePermission);
	const toggle = (id: string, on: boolean) => {
		const next = new Set(selected);
		if (on) next.add(id);
		else next.delete(id);
		void run({ operation: "setBadgePlugins", plugins: [...next] });
	};
	return (
		<SettingsGroup title="Home-screen badge" description="When ToolBelt is installed on a phone’s home screen, its icon shows the total of these plugins’ badges. It updates while the app is open; there are no notifications.">
			{plugins.length ? (
				<div className="grid gap-x-6 gap-y-2 p-5 sm:grid-cols-2">
					{plugins.map((p) => (
						<label key={p.manifest.id} className="flex min-w-0 items-center gap-2 text-sm">
							<Checkbox checked={selected.has(p.manifest.id)} onCheckedChange={(on) => toggle(p.manifest.id, on === true)} />
							<span className="min-w-0 truncate">{p.manifest.name}</span>
						</label>
					))}
				</div>
			) : (
				<div className="px-5 py-4 text-sm text-muted-foreground">No plugins installed.</div>
			)}
			{badgeSupported() && permission !== "granted" && permission !== "unsupported" && (
				<SettingsRow title="This device" description={permission === "denied" ? "Badges are blocked for ToolBelt in this device’s settings." : "iOS shows badges only for apps allowed to notify. ToolBelt never sends notifications."}>
					{permission === "default" && (
						<Button size="sm" variant="outline" onClick={() => void Notification.requestPermission().then(setPermission)}>
							Allow badge on this device
						</Button>
					)}
				</SettingsRow>
			)}
		</SettingsGroup>
	);
}

function ConfirmDialog({ confirmation, close }: { confirmation: Confirmation | null; close: () => void }) {
	const [last, setLast] = useState(confirmation);
	useEffect(() => {
		if (confirmation) setLast(confirmation);
	}, [confirmation]);
	const shown = confirmation ?? last;
	const go = (request: RemoteAccessRequest) => {
		close();
		void run(request);
	};
	return (
		<Dialog open={!!confirmation} onOpenChange={(open) => !open && close()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{shown?.title}</DialogTitle>
					<DialogDescription asChild>
						<div className="space-y-2">{shown?.body}</div>
					</DialogDescription>
				</DialogHeader>
				<DialogFooter className="flex-wrap">
					<Button variant="outline" onClick={close}>Cancel</Button>
					{shown?.alternative && <Button variant="outline" onClick={() => go(shown.alternative!.request)}>{shown.alternative.label}</Button>}
					{shown && <Button autoFocus variant={shown.destructive ? "destructive" : "default"} onClick={() => go(shown.request)}>{shown.confirm}</Button>}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
