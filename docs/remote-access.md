# Remote access (design v1)

Status: design, not implemented. This document records the intended design and the reasons
behind it. When the feature lands, the parts that describe shipped behavior move into
[architecture.md](architecture.md) and [maintenance.md](maintenance.md), and this file keeps
only the deferred work.

## Goal

Use ToolBelt and every installed plugin from a phone or tablet, from anywhere, over a slow
connection if necessary. The use is personal and private: the screens show the processes,
packages and data on one person's Mac.

Remote access is **remote control of the Mac**. Plugins keep running on the Mac, and every
host action keeps its Mac meaning (clipboard, revealing files, opening terminals, file icons).
The remote device is just another screen, keyboard and pointer, with the limits of a small
touch screen.

Non-goals: a native iPhone app, running plugins on the phone, cloud relays, push
notifications, a mobile-specific redesign of plugin screens.

## Decisions

### Plugins run on the Mac; the phone is a remote surface

iOS does not allow an app to spawn Bun processes or download and run code, and the main
plugins (Processes, Upkeep) are about the Mac itself. The architecture already separates
the two halves: plugins send complete declarative trees over JSON lines, and the renderer is
an ordinary React web app. `scripts/preview.ts` already serves the real host and plugins to a
plain browser and bridges the web view RPC over a WebSocket. Remote access turns that bridge
into a product feature of the app.

### Tailscale and the devices are the security boundary

There is no ToolBelt login or pairing. Tailscale decides who can connect. Adding our own
authentication would duplicate what Tailscale already provides (device identity, encryption,
revocation, ACLs) for a single-user tool.

**Owner check.** `tailscale serve` adds a `Tailscale-User-Login` header to every request it
forwards, and removes any copy the client tried to send. The server accepts a request only if
that header equals the Tailscale login that owns the Mac (from `tailscale status --json`:
`Self.UserID` looked up in `User`). That refuses:

- people using a node shared into the tailnet from another tailnet;
- tagged devices (servers, agent machines), which Tailscale never gives identity headers;
- anything that reaches the loopback port directly instead of through Serve, including a DNS
  rebinding page in a browser on the Mac.

Tailscale's guidance for identity headers is the same as this design: listen only on
localhost, so nobody can bypass Serve and send their own headers. Local processes can still do
that, but they already run as the same user. The owner's login is read when remote access
starts and on every status refresh. If it cannot be read, the server refuses everything.

What the owner check does not cover, and the server must also handle:

- **Cross-site WebSockets.** Browsers do not apply the same-origin policy to WebSocket
  connections, so any page open in the phone's browser could try to connect to the Mac's
  tailnet URL. The server accepts HTTP and WebSocket requests only when `Origin` is absent or
  equals the request's own origin, as `src/bun/loopback.ts` does for development controls.
- **DNS rebinding.** A hostile site can rebind its own name to `127.0.0.1`; its requests then
  carry a matching `Host` and `Origin` for that hostile name. The server therefore also
  requires `Host` to be on an allowlist: `localhost`, `127.0.0.1`, `[::1]` and the Mac's
  MagicDNS name.
- **Other users on the tailnet.** If the tailnet has more people, the owner check already
  refuses them. A Tailscale ACL restricting the port to the owner's devices adds a network
  layer underneath; the setup documentation shows the rule.
- **Framing and forwarded headers.** Pages are served with CSP `frame-ancestors 'none'`.
  `X-Forwarded-For`/`-Proto` are read only when the peer is loopback (that is, `tailscale
  serve`), and only for display, never for authorization.

**Device security belongs to the device and the tailnet.** Anyone holding an unlocked
device signed in to the owner's Tailscale account has full control of the Mac through
ToolBelt. The second layer is therefore each device's own passcode or biometric lock, plus
tailnet hygiene. The setup documentation recommends:

- only adding devices to the tailnet that have a passcode or biometric lock and lock
  automatically;
- turning on Tailscale device approval, so a newly signed-in device needs approval in the
  admin console before it joins;
- keeping node key expiry on, so devices re-authenticate periodically;
- removing a lost device in the admin console immediately.

ToolBelt cannot check whether a device has a passcode; this is the owner's responsibility.

Everything is available remotely, including plugin installation, approvals and updates.
Plugin development mode's control plane stays loopback-only: it approves execution of local
archives and has no reason to be remote.

### Loopback server published with `tailscale serve`

The app runs an HTTP/WebSocket server bound to `127.0.0.1` on a dedicated, fixed port, and
a Tailscale Serve rule publishes the same port number over HTTPS:
`https://<machine>.<tailnet>.ts.net:<port>/`. A dedicated port leaves the default HTTPS port
443 to other services, so it never conflicts with them. Serve rules are per port, and
several can coexist.

Rationale:

- Tailscale obtains and renews the HTTPS certificate. The PWA features below (service worker,
  badging) require a secure context, and the app never handles certificates or keys.
- Nothing listens on the LAN or other interfaces, so there is no plain-HTTP exposure on café
  Wi-Fi and no need to choose interfaces.
- `tailscale serve --bg` persists across restarts of both Tailscale and ToolBelt.

Trade-offs: requests through `tailscale serve` arrive from loopback, so the client address
does not distinguish the phone from a local browser; the owner check does. Tailscale's HTTPS
certificates appear in public Certificate Transparency logs, which publishes the machine and
tailnet names (not content); the setup documentation recommends a nondescript machine name.

### Finding the Tailscale CLI

Apps opened from Finder do not inherit the login shell's `PATH`, and the App Store build of
Tailscale does not put `tailscale` on `PATH` at all. ToolBelt looks for the CLI on its own
`PATH`, then in `/opt/homebrew/bin`, `/usr/local/bin` and
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`, and shows which one it uses. If none
exists or it fails to run, the Remote Access tab shows a warning explaining how to install
Tailscale or its CLI, and every Tailscale-dependent control is disabled.

Calling the CLI from another app can trigger a macOS privacy prompt with the App Store build,
so ToolBelt runs it only while remote access is on or the Remote Access tab is open.

### The Serve rule

ToolBelt creates the Serve rule only after the owner confirms it, and can remove it again.
Both happen in the Remote Access tab.

- **Create.** If no rule exists for ToolBelt's port, the tab shows what is missing and a
  "Create Tailscale rule" button. The confirmation states the exact change: HTTPS on tailnet
  port `<port>` forwards to `http://127.0.0.1:<port>`, reachable by devices on the tailnet and
  persisting in Tailscale until removed. On confirmation ToolBelt runs
  `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`.
- **Conflict.** If the port already has a Serve rule that forwards anywhere else, ToolBelt
  never changes it. The tab names the conflict and asks for a different port.
- **Remove.** "Remove Tailscale rule" with a confirmation runs
  `tailscale serve --https=<port> off`. ToolBelt removes a rule only while it still forwards
  to ToolBelt's own address.
- **Verify.** After creating the rule, and on each status refresh while remote access is on,
  ToolBelt requests `/.well-known/toolbelt` through the `ts.net` address. The response carries
  a random instance ID generated at startup, so the tab reports "Reachable" only when the
  address really reaches this server. The probe passes through Serve from the Mac itself, so
  it carries the owner's login and passes the owner check.
- **HTTPS not enabled.** If the tailnet does not allow HTTPS certificates (`https` missing
  from `Self.CapMap`), the tab links to the Tailscale admin console setting instead of
  offering to create the rule.
- **Port change.** The port has a fixed default and can be edited. Changing it while a rule
  exists offers to remove the old rule and create the new one, with the same confirmations.

Quitting ToolBelt leaves the rule in place with nothing to forward to; Tailscale answers with
an error until ToolBelt runs again with remote access on.

### Settings: Remote Access tab

Remote access gets its own Settings tab, beside Appearance, Keyboard, Plugins and About:

- **Remote access** switch, off by default. Off stops the HTTP server and closes every
  remote connection. On starts the server.
- **Tailscale status**, rendered from `tailscale status --json` and
  `tailscale serve status --json` as labelled rows, never as raw JSON: CLI location;
  Tailscale not installed, stopped or running; signed-in login (the owner the check compares
  with); MagicDNS name; whether HTTPS is enabled for the tailnet; the Serve rule's state
  (missing, ToolBelt's, conflicting); and reachability. Each problem state says what to do.
- **Serve rule** controls: create, remove and port, as above.
- **Address** with a copy button and a QR code that opens it on a phone. The QR code holds
  only the URL; there is no secret to leak.
- **Badge total**: the plugins whose badges count toward the PWA's home-screen badge.
- **Connected devices** with live bandwidth figures and Disconnect (below).

The tab works remotely like the rest of the app. Turning remote access off, removing the
rule or changing the port from a remote device cuts that device's own connection, so the
confirmation there adds that access stays lost until someone turns it back on at the Mac.

### One server and dispatcher, shared with preview

The Electrobun RPC handlers in `src/bun/index.ts` and the WebSocket handlers in
`scripts/preview.ts` become one dispatcher that both transports call. The remote server and
preview use the same connection model rather than diverging copies. Preview keeps its
in-memory settings and simulated updates by injecting them into the dispatcher. Unknown
methods fail closed with an error, unlike preview's current switch, which ignores them; a test
checks that every RPC method is handled.

The Mac's own window and popover keep using Electrobun RPC and never pass through the HTTP
server, so the server needs no notion of a trusted local client.

### Connected devices

A device appears in the list while it has a live connection and disappears when it closes.
There is no enrollment. Any of the owner's devices that opens the address and passes the
owner check simply shows up. Device name and OS come from `tailscale whois` on the tailnet
IP that Serve forwards in `X-Forwarded-For`. Several tabs on one device group under it.

Per device the list shows: connected since; bytes sent and received on the wire (after
compression) and before compression; render trees sent and stale trees skipped (the "newest
tree wins" counter); round-trip time from the heartbeat; and whether Tailscale reaches it
directly or through a DERP relay (from the peer's `CurAddr`/`Relay` in `tailscale status
--json`).

**Disconnect** closes that device's connections with a dedicated close code. The client then
stops reconnecting and shows "Disconnected from your Mac" with a Reconnect button. ToolBelt
stores no block list. Disconnect ends a session left open, for example on an iPad; it is not
revocation. A lost or untrusted device is removed in the Tailscale admin console, which takes
it off the tailnet entirely.

### Multiple clients

The Mac window, popover and any number of remote clients share one host. Each connection
tracks the surfaces it has open (preview already does) and closes them when it disconnects.
Rules:

- A plugin's navigation request is routed to the client whose event triggered it, since the
  host only honors navigation within 10 seconds of delivering an event.
- The shared selection relay includes remote clients, with the existing timestamp ordering so
  late deliveries cannot move a highlight back.
- Renderer-local state (typing, scroll, widths, zoom) stays per device. Column layout
  preferences are saved per device, because a phone and a Mac want different widths.

### Renderer adaptation, invisible to plugins

Plugins do not learn that a client is remote or touch-based, and the protocol does not
change. The renderer makes exactly two adaptations:

1. **Main window only.** Remote and touch clients always load the main window. The popover
   and quick views are a menu-bar concept and are skipped (`#popover` redirects to the main
   window).
2. **No key hints without a keyboard.** When the primary input is touch
   (`(hover: none) and (pointer: coarse)`), key hints (`KeyHint`, `Kbd` and shortcut text in
   menus) are hidden. They reappear after the first physical keyboard use, such as an iPad
   with a Magic Keyboard. iOS fires `keydown` for the on-screen keyboard too, so only keys it
   does not produce count: Tab, Escape, arrows and modifier combinations, outside editable
   fields. Accessible names (`aria-keyshortcuts`) are unaffected.

Screen layout on narrow screens relies on the existing narrow-layout behavior; porting
screens is out of scope.

### Progressive web app: manifest and service worker, no push

**Manifest (yes).** A web manifest with icons and `display: standalone` gives a home-screen
icon and full-screen use without browser bars. It costs a JSON file and icons.

**Service worker (yes).** It caches the app shell (HTML, hashed JS/CSS chunks, fonts) so
the app starts without downloading code over a slow link, and it shows a "Mac unreachable"
page instead of a browser error when the Mac is asleep or offline. It is part of the
bandwidth work.

Version safety: a cached shell can be older than the host after an app update. The RPC
handshake carries the app build ID; on a mismatch the client updates the service worker and
reloads. `index.html` is served `no-cache`; hashed assets are immutable.

**Push notifications (no).** ToolBelt has no notifications today (plugins send badges and
in-window toasts, and toasts are mostly replies to the person's own actions). Push would need
a new protocol message for plugins to mark interruptions, which contradicts plugins not
needing to care, and it is the only feature that would send anything outside the tailnet
(through Apple's push service).

**Home-screen badge (yes).** The PWA shows a total on its home-screen icon using the
Badging API (`navigator.setAppBadge`). The Remote Access tab has a "Badge total" choice of zero
or more plugins; the total adds their numeric badges. If the selected plugins have only
non-numeric badges (strings), the icon shows a plain dot (`setAppBadge()` without a count).
Zero selected plugins or a total of zero clears the badge. The choice lives in the host's
`settings.json`, so every device shows the same total.

Limits, accepted: without push, the badge only updates while the PWA is running, and shows
the last value when it was suspended. On iOS the Badging API needs notification permission
even when no notification is ever sent; the app asks only when the owner turns the badge on.

### Bandwidth

The protocol has a useful property: every render message is a complete tree for its
surface. Any message other than the newest for a surface can be dropped without losing
information, and a reconnect only needs the current trees.

Phase 1:

1. **Measure.** Count bytes and messages per connection and surface, readable from the
   diagnostics/debug API, and test over a throttled link. Check whether the phone reaches the
   Mac directly or through a Tailscale DERP relay, which is often the real cause of slowness
   on cellular.
2. **Send only visible surfaces.** Clients close their surfaces when the page is hidden
   (`visibilitychange`) and reopen them when it becomes visible; the host replays the current
   tree on open.
3. **Compression.** Enable WebSocket `permessage-deflate` (Bun's `perMessageDeflate`). Render
   trees are repetitive JSON and should compress roughly tenfold.
4. **Newest tree wins.** When a connection's send buffer is backed up (Bun's `send` reports
   backpressure; `drain` reports recovery), the server keeps only the newest pending tree per
   surface and sends it when the socket drains. The data rate then adapts to the link instead
   of queueing stale screens. Non-render messages (responses, toasts, badges) are never
   dropped.
5. **Caching.** Hashed UI assets and versioned plugin asset references
   (`asset:<id>@<version>/<name>`) are served immutable; the service worker serves the shell
   locally.
6. **Reconnect.** One connection owner per client. The server sends a heartbeat about every
   20 seconds. On `visibilitychange` and `online` the client first probes the existing socket
   and replaces it only if the probe fails, since mobile browsers often keep sockets that
   look alive but are dead. Reconnects use jittered, capped exponential backoff that resets
   only after the connection has stayed up for a while. After reconnecting, the client
   reopens its surfaces and receives their current trees. Pending actions are never
   replayed.

Latency matters as much as bandwidth. Instant state already stays in the renderer. Phase 1
also audits events that fire per keystroke (search and fields) to make sure each round trip
is not visible as lag.

Phase 2: **tree diffs.** The server sends a patch against the last tree the client
acknowledged, falling back to a full tree on mismatch. This is the most effective and most
complex step, and it is built only if measurements after phase 1 show the need.

## Deferred

- **Clipboard and links.** Under the remote-control model, a plugin's clipboard request
  writes the Mac's clipboard and host-opened URLs open on the Mac. Not in this phase.
- **Mac asleep.** Tailscale cannot wake a sleeping Mac. v1 shows the unreachable page.

## Prior art: T3 Code

T3 Code (`pingdotgg/t3code`) publishes its server the same way: loopback plus
`tailscale serve`. Unlike this design, it does not trust the network. Every client, including
its own desktop renderer, pairs with a single-use 5-minute code (QR link with the code in the
URL fragment) and receives a revocable session. Each RPC method requires a scope, and
revoking a session closes its live sockets immediately. That fits its use: multiple users,
plain-HTTP LAN access, a cloud relay, a native iOS app and MCP clients. For one owner who
reaches the Mac only over Tailscale, pairing would mostly re-implement Tailscale's device
identity and revocation. The difference accepted here: any device signed in to the owner's
Tailscale account has full control, with no second factor. T3 Code does not use Tailscale
identity headers; this design uses them instead of pairing.

## Implementation outline

1. Extract the shared RPC dispatcher; move preview onto it.
2. Add the remote server (loopback, dedicated port, owner check, Host/Origin checks,
   `/.well-known/toolbelt`, per-connection surfaces, navigation routing, selection relay,
   heartbeat, Disconnect close code).
3. Tailscale integration: CLI discovery, status reading, Serve rule create/remove/verify.
   Tests use a fake CLI; nothing touches the real Tailscale configuration.
4. Remote Access tab: switch, status rows, Serve rule controls, port, address with QR code,
   badge total, connected devices with bandwidth figures and Disconnect.
5. Renderer: main window only on remote/touch clients; key hints hidden without a keyboard.
6. PWA: manifest, icons, service worker, build-ID handshake, unreachable page, Badging API.
7. Bandwidth phase 1 (items 1–6 above).
8. Documentation: setup (`tailscale serve`, ACL, machine name), architecture and maintenance
   updates, CHANGELOG.

Verification follows AGENTS.md: preview and `chrome-devtools-axi` with touch emulation and
network throttling, an isolated profile, and a real phone over a disposable tailnet setup.
