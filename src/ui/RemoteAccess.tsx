// Settings → Remote Access (docs/remote-access.md): serve ToolBelt to the owner's other devices
// through Tailscale. The switch, Tailscale's status, the Serve rule, the address, paired devices
// and the pairing dialog (code and QR code), the home-screen badge and the connected devices.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import qrcode from "qrcode-generator";
import { AlertTriangle, Check, CircleHelp, Copy, ExternalLink, KeyRound, Loader2, RefreshCw, Smartphone, Trash2, Unplug } from "lucide-react";
import { Switch } from "./components/ui/switch";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { SettingsGroup, SettingsRow } from "./components/settings-layout";
import { remoteAccessRequest, thisDevice, usePlugins, useRemoteAccess, openUrl } from "./lib/store";
import { inApp, remoteClient } from "./lib/device";
import { badgePermission, badgeSupported, CopyAddressButton, InstallSteps, StepText, useInstall } from "./remote-client";
import { pillClass, textClass } from "./renderer/colors";
import { cn } from "./lib/utils";
import { pairingLink, validPort, type PairedDevice, type RemoteAccessRequest, type RemoteAccessState, type RemoteDevice } from "../shared/remote";

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
			<PairedGroup state={state} confirm={setConfirming} />
			<DevicesGroup state={state} />
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
					Devices pair once before they can use it: see Paired devices.
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

function qrSvg(text: string) {
	const qr = qrcode(0, "M");
	qr.addData(text);
	qr.make();
	const n = qr.getModuleCount();
	let path = "";
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" width="148" height="148" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
}

// ── pairing (docs/remote-access.md, "Pairing") ─────────────────────────────────

function PairedGroup({ state, confirm }: { state: RemoteAccessState; confirm: (c: Confirmation) => void }) {
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
			title="Paired devices"
			description="Besides being signed in to your Tailscale account, a device needs this Mac’s approval: pair each phone, tablet or browser once. A home-screen app pairs separately from its browser."
			actions={
				<Button size="sm" disabled={!ready} onClick={() => void start()} title={ready ? undefined : "Turn on remote access and create the Tailscale rule first"}>
					<KeyRound />
					Pair a device
				</Button>
			}
		>
			{state.paired.length ? (
				state.paired.map((device) => (
					<div key={device.id} className="flex flex-wrap items-center gap-3 px-5 py-3 animate-in fade-in-0 duration-300">
						<Smartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-2 text-sm font-medium">
								<span className="break-words">{device.name}</span>
								{device.id === me && <span className={cn("rounded-full px-2 py-0.5 text-xs font-normal", pillClass("default"))}>This device</span>}
								{device.connected && <span className={cn("rounded-full px-2 py-0.5 text-xs font-normal", pillClass("success"))}>Connected</span>}
							</div>
							<div className="text-xs text-muted-foreground">Paired {day(device.pairedAt)} · last used {since(device.lastSeen)}</div>
						</div>
						<Button size="sm" variant="outline" onClick={() => revoke(device)}>
							<Trash2 />
							Remove…
						</Button>
					</div>
				))
			) : (
				<div className="px-5 py-4 text-sm text-muted-foreground">No paired devices yet. {ready ? "Choose Pair a device to show a code." : "Pairing needs remote access on and the Tailscale rule."}</div>
			)}
			<PairDialog state={state} open={open} close={close} />
		</SettingsGroup>
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

function PairDialog({ state, open, close }: { state: RemoteAccessState; open: boolean; close: () => void }) {
	const pairing = state.pairing;
	const remaining = useRemaining(open && pairing ? pairing.expiresAt : null);
	const live = !!pairing && remaining > 0;
	const link = pairing && state.url ? pairingLink(state.url, pairing.secret) : null;
	const svg = useMemo(() => (link ? qrSvg(link) : ""), [link]);
	return (
		<Dialog open={open} onOpenChange={(next) => !next && close()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Pair a device</DialogTitle>
					<DialogDescription>Scan the code with the phone’s camera: it opens ToolBelt already paired, then shows how to add it to the home screen. Or open the address and type the six digits.</DialogDescription>
				</DialogHeader>
				{live && pairing ? (
					<div className="flex flex-wrap items-center justify-center gap-6 animate-in fade-in-0 duration-200">
						{/* Dark modules on white, in both themes: scanners need the contrast. */}
						<div className="shrink-0 rounded-lg bg-white p-2 text-black" role="img" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: svg }} />
						<div className="space-y-2 text-center">
							<div className="font-mono text-3xl font-semibold tabular-nums tracking-[0.2em]" aria-label={`Code ${pairing.code.split("").join(" ")}`}>
								{pairing.code.slice(0, 3)} {pairing.code.slice(3)}
							</div>
							<div className="text-xs text-muted-foreground tabular-nums" aria-live="off">Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</div>
						</div>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">{pairing ? "This code expired." : "This pairing ended: it expired, or too many wrong codes were tried."} Show a new code to pair.</p>
				)}
				{pairing && pairing.paired.length > 0 && (
					<ul className="space-y-1 text-sm" aria-live="polite">
						{pairing.paired.map((name) => (
							<li key={name} className="flex items-center gap-2 animate-in fade-in-0 duration-300">
								<Check className={cn("size-4 shrink-0", textClass("success"))} aria-hidden="true" />
								<span className="min-w-0 break-words">{name} paired</span>
							</li>
						))}
					</ul>
				)}
				<DialogFooter className="flex-wrap">
					<Button variant="outline" onClick={() => void run({ operation: "startPairing" })}>New code</Button>
					<Button autoFocus onClick={close}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
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

function DevicesGroup({ state }: { state: RemoteAccessState }) {
	if (!state.running && !state.devices.length) return null;
	return (
		<SettingsGroup title="Connected devices" description="Devices with ToolBelt open right now. Disconnect ends a session; it isn’t a ban: remove a lost device in Tailscale.">
			{state.devices.length ? (
				state.devices.map((device) => <DeviceRow key={device.ip} device={device} />)
			) : (
				<div className="px-5 py-4 text-sm text-muted-foreground">No devices connected.</div>
			)}
		</SettingsGroup>
	);
}

function DeviceRow({ device }: { device: RemoteDevice }) {
	const stat = (label: string, value: ReactNode) => (
		<div className="min-w-0">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="font-mono text-xs">{value}</dd>
		</div>
	);
	const relayed = device.path?.startsWith("relay");
	return (
		<div className="space-y-3 px-5 py-4 animate-in fade-in-0 duration-300">
			<div className="flex flex-wrap items-center gap-3">
				<Smartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<div className="text-sm font-medium break-words">{device.name}</div>
					<div className="text-xs text-muted-foreground">
						{[device.os, device.ip, `connected ${since(device.connectedAt)}`, device.connections > 1 && `${device.connections} windows`].filter(Boolean).join(" · ")}
					</div>
				</div>
				{device.path && <span className={cn("rounded-full px-2 py-0.5 text-xs", pillClass(relayed ? "warning" : "default"))} title={relayed ? "Tailscale can’t connect directly and relays this device’s traffic, which is slower." : undefined}>{device.path}</span>}
				<Button size="sm" variant="outline" onClick={() => void run({ operation: "disconnect", ip: device.ip }, `${device.name} disconnected`)}>
					<Unplug />
					Disconnect
				</Button>
			</div>
			<dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
				{stat("Sent", <>{bytes(device.bytesOut)}<span className="block text-muted-foreground">≈{bytes(device.wireOut)} compressed</span></>)}
				{stat("Received", bytes(device.bytesIn))}
				{stat("Screens sent", device.treesSent.toLocaleString())}
				{stat("Stale skipped", device.treesSkipped.toLocaleString())}
				{stat("Round trip", device.rtt === null ? "—" : `${device.rtt} ms`)}
			</dl>
		</div>
	);
}

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
