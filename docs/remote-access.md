# Remote access

Remote access serves ToolBelt and every installed plugin to the owner's phone or tablet,
from anywhere and over slow connections, through Tailscale. This document is the reference
for how it works and why. [architecture.md](architecture.md) summarizes it and
[maintenance.md](maintenance.md) covers testing it.

The use is personal and private: the screens show the processes, packages and data on one
person's Mac. Remote access is **remote control of the Mac**. Plugins keep running on the Mac,
and every host action keeps its Mac meaning (clipboard, revealing files, opening terminals,
file icons). The remote device is another screen, keyboard and pointer, with the limits of a
small touch screen.

Non-goals: a native iPhone app, running plugins on the phone, cloud relays, push
notifications, mobile-specific plugin screens.

| Area | Implementation |
| --- | --- |
| Shared types, close codes, badge total | `src/shared/remote.ts` |
| Tailscale CLI: discovery, status, Serve rule | `src/bun/tailscale.ts` |
| HTTP/WebSocket server, request checks, outgoing queue | `src/bun/remote-server.ts` |
| Server lifecycle, owner, rule, reachability, devices | `src/bun/remote-access.ts` |
| App wiring: remote views, allowed methods, navigation | `src/bun/index.ts` (remote access section) |
| Browser connection: reconnects, heartbeat, visibility | `src/ui/lib/connection.ts`, `src/ui/lib/store.ts` |
| Device detection, key hints | `src/ui/lib/device.ts`, `index.css` |
| Connection banner, badge, service worker, install card | `src/ui/remote-client.tsx` |
| Install help rules (device, browser, steps) | `src/ui/lib/install.ts` |
| Settings → Remote Access | `src/ui/RemoteAccess.tsx` |
| Web app shell | `src/ui/public/sw.js`, `manifest.webmanifest`, `index.html`, copies in `electrobun.config.ts` |

## Setup

1. Install Tailscale on the Mac and the phone, sign both in to the same account, and enable
   MagicDNS and HTTPS certificates for the tailnet in the Tailscale admin console.
2. In ToolBelt, open Settings → Remote Access, check the Tailscale rows, choose **Create
   Tailscale rule…** and confirm, then turn remote access on.
3. On the phone, scan the QR code with the camera. The page shows how to add ToolBelt to the
   home screen (on Android, an **Install ToolBelt** button).

Recommended tailnet hygiene (the tab repeats it):

- Add only devices that lock automatically with a passcode or biometrics.
- Turn on device approval, so a newly signed-in device needs approval before it joins.
- Keep node key expiry on, so devices sign in again periodically.
- Remove a lost device in the admin console immediately.
- Give the Mac a nondescript machine name: Tailscale's HTTPS certificates appear in public
  Certificate Transparency logs, which publishes the machine and tailnet names (not content).
- If other people share the tailnet, restrict the port in the tailnet policy to your own
  devices (an ACL rule accepting only you → you:`<port>`, with no broader rule covering it).
  The owner check below already refuses them; the ACL adds a network layer underneath.

## Plugins run on the Mac; the phone is a remote surface

iOS does not allow an app to spawn Bun processes or download and run code, and the main
plugins (Processes, Upkeep) are about the Mac itself. The architecture already separates the
two halves: plugins send complete declarative trees over JSON lines, and the renderer is an
ordinary React web app. Remote access serves that renderer to other devices and bridges the web
view RPC over a WebSocket, the way the browser preview always has.

## Security: Tailscale and the devices are the boundary

There is no ToolBelt login or pairing. Tailscale decides who can connect. ToolBelt's own
authentication would duplicate what Tailscale already provides (device identity, encryption,
revocation, ACLs) for a single-user tool.

**Owner check.** `tailscale serve` adds a `Tailscale-User-Login` header to every request it
forwards and removes any copy the client sent. The server accepts a request only when that
header equals the login that owns the Mac (`tailscale status --json`: `Self.UserID` looked up in
`User`). That refuses:

- people using a node shared into the tailnet from another tailnet;
- tagged devices (servers, agent machines), which Tailscale never gives identity headers;
- anything that reaches the loopback port directly instead of through Serve, including a DNS
  rebinding page in a browser on the Mac.

Tailscale's guidance for identity headers matches this design: listen only on localhost, so
nobody can bypass Serve and send their own headers. Local processes still can, but they
already run as the same user. The owner's login is read when remote access starts and on every
status refresh; while it is unknown the server refuses everything (503).

`checkRemoteRequest` also requires:

- a loopback peer (Serve);
- a `Host` on the allowlist: `localhost`, `127.0.0.1`, `[::1]` and the Mac's MagicDNS name;
- an absent `Origin`, or one equal to the request's own host. Browsers don't apply the
  same-origin policy to WebSockets, so this is what stops a page open on the phone from
  connecting to the Mac.

Responses carry CSP `frame-ancestors 'none'`, `nosniff` and `no-referrer`. `X-Forwarded-For`
(the device's tailnet IP) is read only from a loopback peer and only identifies the device in
the list; it never authorizes anything.

**Device security belongs to the device and the tailnet.** Anyone holding an unlocked device
signed in to the owner's Tailscale account has full control of the Mac through ToolBelt.
ToolBelt cannot check whether a device has a passcode; that, and the tailnet hygiene above, are
the owner's responsibility.

Everything is available remotely, including plugin installation, approvals, updates and the
Remote Access tab itself. Remote connections get the same request handlers as a web view except
`popoverLayout` (the native popover's geometry) and `development`: plugin development mode
approves execution of local archives and stays on the Mac. Unknown methods fail closed. Of the
web view messages, remote connections may send only `selectionChanged` and `quit`; window
commands (close, zoom, show, hide) are the Mac's.

## Loopback server published with Tailscale Serve

The app runs the server on `127.0.0.1` at a dedicated port (47380; ToolBelt Dev uses 47381 so
both can run), and a Tailscale Serve rule publishes the same port over HTTPS:
`https://<machine>.<tailnet>.ts.net:<port>/`. A dedicated port leaves 443 to other services;
Serve rules are per port and coexist.

- Tailscale obtains and renews the certificate. The service worker and Badging API need a
  secure context, and ToolBelt never handles certificates or keys.
- Nothing listens on the LAN, so there is no plain-HTTP exposure on shared Wi-Fi.
- The rule persists across restarts of Tailscale and ToolBelt.

Requests through Serve arrive from loopback, so the peer address does not distinguish the
phone from a local browser; the owner check does. The Mac's own window and popover keep using
Electrobun RPC and never pass through this server, so it needs no notion of a trusted local
client.

## The Tailscale CLI

Apps opened from Finder don't inherit the login shell's `PATH`, and the App Store build of
Tailscale doesn't put `tailscale` on `PATH` at all. `findTailscaleCli` checks `PATH`, then
`/opt/homebrew/bin`, `/usr/local/bin` and `/Applications/Tailscale.app/Contents/MacOS/Tailscale`,
and the tab shows which one it uses. Without one, the tab explains how to install it and nothing
Tailscale-dependent is offered.

Calling the CLI from another app can trigger a macOS privacy prompt with the App Store build,
so ToolBelt runs it only while remote access is on (a status refresh every 30 seconds) or when
the Remote Access tab reads or refreshes. Every call has a 15-second timeout. Tests inject a
fake runner and never touch a real Tailscale configuration.

## The Serve rule

ToolBelt changes Tailscale's configuration only after the owner confirms, in the Remote Access
tab.

- **Create.** With no rule on the port, the tab offers **Create Tailscale rule…**. The
  confirmation states the exact change (HTTPS on tailnet port `<port>` → `http://127.0.0.1:<port>`)
  and that it persists until removed. ToolBelt then runs
  `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`.
- **Conflict.** If the port already has any other Serve configuration (another target, another
  mount, files, text, TCP forwarding or plain HTTP), ToolBelt never changes it; the tab names
  the target and asks for a different port.
- **Remove.** **Remove rule…** with a confirmation runs `tailscale serve --https=<port> off`, and
  only while the rule still forwards to ToolBelt's own address.
- **Verify.** While remote access is on and the rule is ToolBelt's, each refresh requests
  `/.well-known/toolbelt` through the `ts.net` address. The response carries a random ID
  generated at startup, so "Reachable" means the address really reaches this ToolBelt. This
  endpoint skips the owner requirement (it reveals only that ID) but keeps the other checks.
- **HTTPS not enabled.** Without `https` in `Self.CapMap`, the tab links to the admin console
  instead of offering the rule. MagicDNS off is reported the same way.
- **Port change.** Changing the port while ToolBelt's rule exists offers **Move the rule**
  (remove the old rule, create the new one) or **Change port only**.

Quitting ToolBelt leaves the rule with nothing to forward to; Tailscale answers with an error
until ToolBelt runs again with remote access on.

## Settings → Remote Access

- **Serve ToolBelt to your devices**: off by default. Off stops the server, closing every
  remote connection with the "off" close code; on starts it. Errors such as a port in use show
  here.
- **Open on your phone**: the address, a copy button and a QR code holding only the URL (no
  secret). Shown once the rule is ToolBelt's.
- **Port**.
- **Tailscale**: labelled rows from `tailscale status --json` and `tailscale serve status
  --json` (CLI location, running state, account, MagicDNS name, HTTPS certificates, Serve rule,
  reachability), each problem with what to do, and the device-security reminder.
- **Connected devices** (below).
- **Home-screen badge**: which plugins count toward the badge, and on a device that needs it,
  the button that asks for badge permission.

The tab works remotely too. Turning remote access off, removing the rule or changing the port
from a remote device cuts that device's own connection, so those confirmations add that access
stays lost until it is set up again at the Mac.

## Connected devices

A device appears while it has a live connection and disappears when it closes. There is no
enrollment: any of the owner's devices that opens the address and passes the owner check shows
up. Its name, OS and path come from the peer in `tailscale status --json` whose tailnet IP Serve
forwarded; several windows on one device group under it.

Per device: connected since; bytes sent (and an estimate after compression, from sampling
every eighth larger message with deflate) and received; screens sent and stale screens skipped;
the heartbeat round trip; and whether Tailscale reaches it directly or through a DERP relay
(`CurAddr`/`Relay`). A relay is often the real cause of slowness on cellular.

**Disconnect** closes the device's connections with close code 4001. The client stops
reconnecting and shows "Disconnected from your Mac" with **Reconnect**. ToolBelt stores no block
list: Disconnect ends a session left open; removing a device belongs in Tailscale.

## Multiple clients

The Mac window, popover and any number of remote connections share one host. Each remote
connection is a view of its own in `index.ts`: it receives every broadcast, tracks the surfaces
it opened and closes them when it goes away.

- A plugin's navigation goes back to the remote view whose event triggered it (the host honors
  navigation only within 10 seconds of an event); otherwise it opens the Mac window as before.
- The shared selection relay includes remote views, with the existing timestamp ordering.
- Renderer-local state (typing, scroll, widths, zoom, column layouts) stays per device.
- The client sends one `open` per surface however many components watch it, and one `close`
  when the last one stops, matching the server's per-view surface set.

## Renderer adaptation, invisible to plugins

Plugins don't learn that a client is remote or touch-based, and the protocol doesn't change.

1. **Main window only.** Remote clients (a browser not on `localhost`) and touch-first devices
   never get the popover: `#popover` is replaced by the main window.
2. **No key hints without a keyboard.** When the primary pointer is touch
   (`(hover: none) and (pointer: coarse)`), `html[data-keyboard="none"]` hides `Kbd`, `KeyHint`
   and menu shortcuts. The Keyboard settings tab's reference list keeps them (`data-keep-keys`).
   Hints return on the first physical-keyboard evidence: iOS fires `keydown` for the on-screen
   keyboard too, so only keys it can't produce count (Tab, Escape, arrows, Page keys, F6, ⌘/⌃
   combinations, ⌥ outside text fields). `aria-keyshortcuts` is unaffected.
3. **Narrow screens.** Below 768 px the sidebar is a sheet: the pane header shows a **Show
   tools** button, and choosing a tool closes the sheet. Without window buttons (remote and
   touch devices) the header doesn't reserve their room, and the preview's stand-in buttons
   aren't drawn.

Plugin screens otherwise rely on the existing narrow-layout behavior.

## Web app: manifest and service worker, no push

**Manifest.** `manifest.webmanifest` (standalone display; 192 and 512 px icons, the 512 also
maskable) and the iOS meta tags in `index.html` (a 180 px `apple-touch-icon`) make ToolBelt
installable on the home screen and full screen without browser bars. The icons are full-bleed
renders of the app artwork (`bun run icons` writes `assets/web-app-icon{,-dev}-{180,192,512}.png`):
the macOS icon's transparent margin and shadow would show as a black frame on iOS. The build
copies the official or dev set into `views/ui/pwa/`; the preview serves them from `assets/`.

**Installing.** Web pages can't install themselves on iOS, and only Chromium on Android offers
a prompt, so `lib/install.ts` decides what to show from the user agent (iPadOS reports a Mac
with touch points) and whether ToolBelt already runs standalone:

- **Installed, or a computer:** nothing.
- **Android with a deferred `beforeinstallprompt`** (Chrome, Edge, Samsung Internet): an
  **Install ToolBelt** button that opens the browser's dialog.
- **iPhone/iPad Safari:** Share → Add to Home Screen → Add, with Share placed for the device.
  Chrome and Edge on iOS get the same steps from their address bar, with Safari as the fallback;
  other iOS browsers are sent to Safari.
- **Android without a prompt** (Firefox, or before Chrome offers it): the browser menu's
  Install / Add to Home screen.

`InstallCard` shows this once per device at the bottom of the screen (dismissal is kept in
local storage). The QR code links to `…/?install`, which shows it again on arrival and is
removed from the address. Settings → Remote Access on the phone has a **This device** section
with the same help. In the installed app's first launch, the card instead offers the badge
permission when the Mac has chosen badge plugins (iOS only asks from an installed app).

**Service worker** (`sw.js`, registered only on remote clients in a secure context):

- hashed build files under `/assets/` come from the cache once fetched; when a page with a new
  main script arrives, the asset cache starts over, so old builds don't pile up;
- the page itself is network-first, falling back to the cached copy (whose connection banner
  explains the Mac can't be reached) or, with nothing cached, a static "Can't reach your Mac"
  page;
- `/rpc` and `/.well-known/` are never intercepted.

**Version safety.** The build ID is the main script's hashed file name. After each connection
the client asks the server for its build (`buildId`); on a mismatch it updates the service
worker and reloads once per build. The server sends `index.html`, `sw.js` and the manifest with
`no-cache` and `/assets/` as immutable.

**Push notifications: no.** ToolBelt has no notifications (plugins send badges and in-window
toasts, mostly replies to the person's own actions). Push would need a protocol message for
plugins to mark interruptions, contradicting plugins not needing to care, and would be the only
traffic leaving the tailnet (through Apple's push service).

**Home-screen badge.** `BadgeSync` sets the icon's badge with the Badging API from the chosen
plugins: the sum of their numeric badges (digit strings count), a plain dot when they only have
text badges, nothing otherwise (`badgeTotal`). The choice lives in the host's `settings.json`
(`remote.badgePlugins`) and arrives with `settings`, so every device shows the same total.
Accepted limits: without push the badge only updates while the app runs; on iOS it needs
notification permission, which the tab asks for on that device, although nothing is ever sent.

## Bandwidth

Every render message is a complete tree for its surface, so any message other than the newest
for a surface can be dropped without losing information, and a reconnect only needs the current
trees.

1. **Measure.** The devices list shows bytes, screens, skipped screens, round trip and relay
   per device; `remote` in the debug channel's `/state` has the same.
2. **Only visible surfaces.** When the page is hidden the client closes its surfaces; when it
   is shown again on a live socket it reopens them and receives their current trees.
3. **Compression.** WebSocket `permessage-deflate`.
4. **Newest tree wins.** `OutboundQueue` sends straight through until the socket has more than
   256 KiB buffered. Then messages wait in order, a waiting tree is replaced by a newer one for
   the same surface (counted as skipped), and the queue flushes on `drain`. Nothing else is
   dropped.
5. **Caching.** Immutable hashed assets and the service worker's shell cache.
6. **Reconnect.** One connection owner per page (`createSocketTransport`). The server sends a
   heartbeat every 20 seconds; 50 seconds of silence counts as a dead socket. On becoming
   visible the client first probes the existing socket (any message within 3 seconds) and
   replaces it only if the probe fails; `online` reconnects at once. Reconnects use jittered,
   capped exponential backoff (1 s doubling to 30 s) that resets only after the connection has
   stayed up for 10 seconds; after "off" (4002) it retries every 15 seconds or more. Requests in
   flight when the socket drops fail; plugin events are refused while offline and never queued,
   so an action taken offline can't run later. Other requests wait up to 15 seconds for the
   connection.

The connection banner reports connecting (after 800 ms), offline with **Retry now**, remote
access off, and the Disconnect dialog.

## Deferred

- **Tree diffs (phase 2).** Patches against the last tree the client acknowledged, falling back
  to a full tree on mismatch. Built only if measurements show the need.
- **Plugin images over HTTP.** `pluginAsset` still returns data URLs over the RPC, so plugin
  images aren't HTTP-cached on remote devices.
- **Per-keystroke events.** Search and field events cost a round trip each; not yet audited
  for latency on slow links.
- **Clipboard and links.** A plugin's clipboard request writes the Mac's clipboard, and
  host-opened URLs open on the Mac.
- **Mac asleep.** Tailscale can't wake a sleeping Mac; the banner or the offline page shows.

## Prior art: T3 Code

T3 Code (`pingdotgg/t3code`) publishes its server the same way: loopback plus `tailscale
serve`. Unlike this design, it does not trust the network. Every client, including its own
desktop renderer, pairs with a single-use five-minute code (a QR link with the code in the URL
fragment) and receives a revocable session; each RPC method requires a scope, and revoking a
session closes its live sockets. That fits its use: multiple users, plain-HTTP LAN access, a
cloud relay, a native iOS app and MCP clients. For one owner reaching the Mac only over
Tailscale, pairing would mostly re-implement Tailscale's device identity and revocation. The
difference accepted here: any device signed in to the owner's Tailscale account has full
control, with no second factor. T3 Code does not use Tailscale identity headers; this design
uses them instead of pairing. Borrowed from it: the Serve-based publishing, the
`/.well-known/` reachability probe, never touching a rule that isn't ToolBelt's, running the
CLI only while needed, and the reconnect policy.
