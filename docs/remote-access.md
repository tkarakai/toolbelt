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
| Which local user is behind a loopback connection | `src/bun/peer-owner.ts` |
| Paired devices, pairing codes, the devices file | `src/bun/pairing.ts` |
| Server lifecycle, owner, rule, reachability, devices | `src/bun/remote-access.ts` |
| App wiring: remote views, allowed methods, navigation | `src/bun/index.ts` (remote access section) |
| Browser connection: reconnects, heartbeat, visibility | `src/ui/lib/connection.ts`, `src/ui/lib/store.ts` |
| Device detection, key hints | `src/ui/lib/device.ts`, `index.css` |
| Narrow layout, touch gestures | `src/ui/App.tsx`, `components/mobile-tab-bar.tsx`, `lib/touch.ts`, `lib/hide-on-scroll.ts`, `hooks/use-mobile.ts`, `renderer/Render.tsx` |
| Connection banner, badge, service worker, install card | `src/ui/remote-client.tsx` |
| Install help rules (device, browser, steps) | `src/ui/lib/install.ts` |
| Settings → Remote Access | `src/ui/RemoteAccess.tsx` |
| Web app shell | `src/ui/public/sw.js`, `manifest.webmanifest`, `index.html`, copies in `electrobun.config.ts` |

## Setup

1. Install Tailscale on the Mac and the phone, sign both in to the same account, and enable
   MagicDNS and HTTPS certificates for the tailnet in the Tailscale admin console.
2. In ToolBelt, open Settings → Remote Access, check the Tailscale rows, choose **Create
   Tailscale rule…** and confirm, then turn remote access on.
3. Choose **Pair a device** and scan its QR code with the phone's camera. The page opens
   already paired and shows how to add ToolBelt to the home screen (on Android, an **Install
   ToolBelt** button). Opened from the home screen, the app pairs once more: choose **Type a
   code instead** and enter the code it shows. Later devices can be paired from the Mac or from
   a device that is already paired.

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

## Security: Tailscale, then pairing

Tailscale decides who can reach ToolBelt: device identity, encryption and the owner's account.
Pairing then decides which of the owner's browsers may use it: a work laptop, an old tablet or
a lost phone that is still signed in to the account gets nothing until it is approved, on the
Mac or from a device that is already paired (see Pairing). There is no ToolBelt password.

**Owner check.** `tailscale serve` adds a `Tailscale-User-Login` header to every request it
forwards and removes any copy the client sent. The server accepts a request only when that
header equals the login that owns the Mac (`tailscale status --json`: `Self.UserID` looked up in
`User`). That refuses:

- people using a node shared into the tailnet from another tailnet;
- tagged devices (servers, agent machines), which Tailscale never gives identity headers;
- anything that reaches the loopback port directly instead of through Serve, including a DNS
  rebinding page in a browser on the Mac.

Tailscale's guidance for identity headers matches this design: listen only on localhost, so
nobody off the Mac can bypass Serve and send their own headers. On the Mac, though, every
account and daemon shares loopback and could forge the header. **Peer-owner check**
(`src/bun/peer-owner.ts`): before the `/rpc` socket opens, the server looks up the process on
the client end of the loopback connection (`netstat -anv`, which reports any user's sockets)
and its user (`ps`). Through Serve that process is Tailscale itself: the App Store extension
runs as the signed-in user, the standalone and open-source daemons as root. Any other owner,
an unknown connection or a failed lookup is refused (403). Processes of the same user still
pass; they could already act as that user. Static files skip the check: they are the public UI
build.

Serving on an owner-only Unix socket (`tailscale serve unix:/path`) would avoid loopback
entirely, but the App Store build's network extension is sandboxed and can't connect to Unix
sockets outside its own container: such a rule answers 502 wherever the socket lives (checked
with Tailscale 1.104 under Application Support, `/tmp`, `$TMPDIR` and `~/Downloads`). Its
app-group container is protected from other apps.

The owner's login is read when remote access starts and on every
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

**Device security belongs to the device and the tailnet.** Anyone holding an unlocked, paired
device signed in to the owner's Tailscale account has full control of the Mac through ToolBelt.
ToolBelt cannot check whether a device has a passcode; that, and the tailnet hygiene above, are
the owner's responsibility.

Everything is available remotely, including plugin installation, approvals, updates and the
Remote Access tab itself. Remote connections get the same request handlers as a web view except
`popoverLayout` (the native popover's geometry) and `development`: plugin development mode
approves execution of local archives and stays on the Mac. `setShortcut` and `pauseShortcut`
also stay: the global shortcut is the Mac's, and a connection lost while recording would leave
it paused, so the Keyboard tab hides the shortcut recorder remotely. Unknown methods fail closed. Of the
web view messages, remote connections may send only `selectionChanged` and `quit`; window
commands (close, zoom, show, hide) are the Mac's.

## Pairing

Every browser connection must present a paired device's token, or pair, before anything else
works. The owner and peer-owner checks still come first; pairing is a second gate, not a
replacement.

- **Who approves.** ToolBelt on the Mac, or on any device that is already paired: **Pair a
  device** works remotely too. That is deliberate. A paired device already has full control
  (it can install plugins, which run code on the Mac), so letting it approve more of the owner's
  devices adds no power, and it lets the owner pair a tablet away from the Mac. The new device
  must still be signed in to the owner's Tailscale account and pass the owner check, so a paired
  device can't let anyone else in. **Remove…** takes approval back from any device, including
  ones another device approved. Pairing proves possession of the Mac or of a paired device, not
  presence at the Mac.
- **Showing a code.** **Pair a device** in Settings → Remote Access (enabled once the server
  runs and the rule is ToolBelt's) starts a pairing: a six-digit code and a QR code linking to
  `…/?install#pair=<secret>`, a 256-bit one-time secret in the fragment, which browsers never
  send to the server. It lasts five minutes (`PAIRING_TTL_MS`); while the dialog is open, an
  expired or ended pairing is replaced by a new one. **Done** ends it, and so does turning
  remote access off. Five wrong codes end it too (`PAIRING_MAX_FAILURES`), which caps guessing
  at five tries per code shown.
- **The dialog.** It opens on the QR code alone, with one instruction: point the phone's camera
  (on a remote device, the other device's) at it and tap the link. The digits appear only after
  **Type a code instead** (for a device that can't scan, or the home-screen app), as two steps:
  open ToolBelt on the device, from its home screen or by opening the address shown (with
  **Copy**) in its browser; then type the code, shown as six tiles with when it is replaced.
  Devices paired meanwhile are listed in both views.
- **Pairing.** Scanning the QR code is the pairing: the page takes the secret out of the address
  before the router reads it and pairs at once, with nothing to type. Otherwise the device shows
  its pairing screen: three steps (open Settings → Remote Access on the Mac or a paired device,
  choose **Pair a device** then **Type a code instead**, enter the code) above a six-tile code
  field. The field has focus at once, so the code can be typed or pasted right away, and a
  six-digit code pasted anywhere on the screen counts; iOS shows its keyboard only after a tap,
  so the tiles are one large target. The sixth digit submits; a wrong code clears the field and
  says why. Within the five minutes any number of devices may pair, so a phone can pair its
  browser and then its home-screen app (iOS gives them separate storage), which types the code.
  Requests made meanwhile wait, and the page carries on once paired.
- **Tokens.** A paired device gets a random 256-bit token, kept in its local storage (in memory
  only if storage is refused, so it lasts until the page closes). ToolBelt stores only SHA-256
  hashes, with the name, pairing time and last use, in `remote-devices.json` beside
  `settings.json`, written atomically with mode 0600. An unreadable file counts as no devices:
  everything pairs again rather than anything getting in.
- **Names.** The device's Tailscale name plus how ToolBelt runs there, e.g.
  `iphone (Home Screen app)` or `ipad (Safari)`, made unique with a number.
- **Removing.** In **Devices**, **Remove…** forgets a device and closes its connections with
  close code 4003: the client forgets its token and shows the pairing screen. From the device
  itself, the confirmation says that it loses access. Disconnect (4001) only ends a session; the
  pairing stays.

Protocol: after the socket opens, the client sends `{ kind: "hello", token? }`; the server
answers `{ kind: "paired", device }` and only then treats the connection as opened (it joins the
views, gets messages, may send requests), or `{ kind: "unpaired" }`. An unpaired connection may
send `{ kind: "pair", secret, label }` with the code or the QR secret and gets `paired` (with the
new `token`) or `{ kind: "pairFailed", error }`. Any request before that fails with "Pair this
device with your Mac first", and no messages are sent to it. The Mac's own window and popover
use Electrobun RPC and never pair. The preview's own server pairs only with
`PREVIEW_REQUIRE_PAIRING=1`, and `/remote?pairing=start` shows a code there.

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
  (create the new rule, then remove the old one) or **Change port only**. A running server
  starts on the new port before the old one stops, and a port already in use is refused before
  the rule or the server moves.

Changes to the server, the rule and the port run one at a time, in order (the switch, port and
rule controls are disabled meanwhile), so repeated or crossing requests from the Mac and a
remote device can't start a second server or leave one running after the switch is off. A
surface holds at most one viewer count per connection: opening it again (a reconnect's resync)
or closing it twice doesn't change the host's count.

Quitting ToolBelt leaves the rule with nothing to forward to; Tailscale answers 502 until
ToolBelt runs again with remote access on. The service worker treats that as unreachable.

## Settings → Remote Access

- **Serve ToolBelt to your devices**: off by default. Off stops the server, closing every
  remote connection with the "off" close code; on starts it. Errors such as a port in use show
  here.
- **Address**: the address and a copy button, once the rule is ToolBelt's.
- **Port**.
- **Devices** and **Pair a device** (below, and Pairing).
- **Home-screen badge**: which plugins count toward the badge, and on a device that needs it,
  the button that asks for badge permission.
- **Tailscale**, last because it matters mainly during setup: labelled rows from `tailscale
  status --json` and `tailscale serve status --json` (CLI location, running state, account,
  MagicDNS name, HTTPS certificates, Serve rule, reachability), each problem with what to do,
  and the device-security reminder.

The tab works remotely too. Turning remote access off, removing the rule or changing the port
from a remote device cuts that device's own connection, so those confirmations add that access
stays lost until it is set up again at the Mac.

## Devices

Only paired devices can connect, so one list covers both: every paired device, one row per
browser or home-screen app (a phone's Safari and its home-screen app are two rows), connected
ones first, each with an icon for a phone, tablet or computer. A device that isn't connected
shows when it was last used (the end of its last connection). A connected one shows
"Connected", the path and round trip, and **Details**, which expands its connection: OS,
tailnet IP and path from the peer in `tailscale status --json` whose IP Serve forwarded,
connected since, windows (summed), data and screens sent, and when it was paired. Actions are in
the row's ⋯ menu: **Disconnect** (while connected) and **Remove…**, so the row stays one column
on a phone.

Per connected device, in Details: bytes sent (and an estimate after compression, from sampling
every eighth larger message with deflate) and received; screens sent and stale screens skipped;
the heartbeat round trip; and whether Tailscale reaches it directly or through a DERP relay
(`CurAddr`/`Relay`). A relay is often the real cause of slowness on cellular.

**Disconnect** closes that device's connections (not others from the same phone) with close
code 4001. The client stops
reconnecting and shows "Disconnected from your Mac" with **Reconnect**. Disconnect ends a
session left open; to keep a device out, remove its pairing (or the device in Tailscale).

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
3. **Narrow screens** (below 768 px, `useIsMobile`; `usePhone` and the CSS `phone:` variant add
   "not the Mac's popover", which is narrow too and keeps its desktop behavior):
   - The sidebar is a sheet with finger-sized rows and Settings named, opened by the header's
     **Show tools** button (☰) or a swipe in from the left edge; choosing a tool closes it.
     Without window buttons (remote and touch devices) the header doesn't reserve their room,
     and it keeps clear of the notch and status bar (`safe-area-inset-*`).
   - A plugin's tabs, and Settings' tabs, move from the header to a bar along the bottom
     (`MobileTabBar`): icon over the screen title, the chosen tab's icon in a selection-color
     pill, clear of the home indicator. The header keeps the tool's name and the pane actions.
     The bar publishes its height as `--mobile-tab-bar`, which toasts and the install card sit
     above.
   - While the content scrolls down (24 px in one go), the header slides up and the tab bar
     down, giving their room to the content; scrolling up 12 px, reaching the top, a new tab or
     focus moving into a bar brings them back (`lib/hide-on-scroll.ts`, `SlideAway`). Content
     with little to scroll keeps them. Each bar's row collapses over 200 ms, so the content
     grows as the bar moves out.
   - Switching tools and tabs on a touch screen replaces the history entry instead of adding
     one (`setHash` in `App.tsx`): phone tab bars don't stack up Back steps, and with no
     ToolBelt history iOS's own back swipe from the left edge (in Safari and in home-screen
     apps) has nothing to go back to, leaving the edge to the tools sheet. Pages can't block
     that system gesture, so it still wins when the tab came from another page.
   - Page toolbars narrower than 480 px stack: the filter box (taking the free width) and the
     actions as larger icon buttons on one row, the filters, controls and summary scrolling
     sideways on a row of their own.
   - The details drawer can't fit, so a tapped row opens its details or row pane in a sheet from
     the bottom (on phone-width windows and touch screens; a medium-width Mac window keeps clicks
     selecting), sliding its full height in 200 ms (grab handle; a downward swipe, a tap outside or Esc closes it). A tapped row
     without details opens or closes its children, and a tapped group heading collapses or
     expands; double clicks then do nothing more.
   - Dialogs, including resizable ones, are sheets along the bottom, up to 92% of the height,
     sliding in and out over 200 ms, with stacked full-width buttons in thumb reach. They can't be moved or resized.
   - Rows in settings, cards, plugin cards and boxed forms wrap or stack before their text gets
     squeezed: a card's actions wrap below its title, a form field's control goes under its
     label at full width (switches stay beside it), a status value goes under its label.

Plugin screens need no changes for any of this (see "Who is responsible" below).

## Touch

`src/ui/lib/touch.ts` holds the gestures, with the decisions as pure functions
(`test/touch.test.ts`). They apply to touch input only; mouse and trackpad behavior is
unchanged.

- **Long press** (450 ms, within 8 px): on a table row it opens the row's actions menu. On a row
  that can be reordered it lifts the row instead; dragging then moves it, releasing in place
  opens the menu. A long press lifts a sidebar tool or an arranged filter to drag it. A press
  that moves first is a scroll, so swiping a list or toolbar never starts a drag. While lifted,
  page scrolling is held off. Android vibrates briefly; iOS has no web haptics.
- **Edge swipe**: from the left 24 px, 48 px mostly sideways opens the tools sheet. iOS claims
  the edge for its back gesture when there is a page to go back to; ToolBelt adds no history of
  its own on touch screens (see "Narrow screens"), so this only happens in a browser tab that
  came from another page.
- **Swipe to dismiss**: the tools sheet (swiped left) and the details sheet (swiped down)
  follow the finger and close when pulled past 30% or flung; otherwise they spring back. A
  pull starts only where the content can't scroll that way itself.
- **Targets and text**: row ⋯ and expand buttons get a larger hit area (`data-touch-target`),
  and text fields use 16 px so iOS doesn't zoom on focus. There's no tap highlight, no
  double-tap zoom delay on controls, no rubber-banding of the app, and rows don't select text
  or show the iOS callout on a long press. The document never scrolls, only the panes, and the
  panes fill the dynamic viewport (`h-dvh`): iOS can't shift the app (and its bottom tab bar)
  when something takes focus, and no gap opens under the bar as Safari's toolbars resize.
- On touch screens, Settings → Keyboard starts with a **Touch gestures** list; the keyboard
  reference follows, for a connected keyboard.

Not adopted: swiping between tabs or across rows (tables scroll sideways and rows already have
long press), and pull to refresh (plugins push updates themselves).

## Who is responsible: the host

Plugins send declarative trees and never ship browser code, so layout is the host's: every
adaptation above applies to every plugin, and the protocol has no "narrow" or "touch" signal.
Plugins help by what they already declare: an `icon` on page actions and screens (icon buttons
and the tab bar need one), short screen titles, column minimum widths and `overflow` (which
columns hide first), concise toolbar `summary` text, and a row `pane` or `details` for what
needs room. Text that names keys ("Press ↵ …") reads oddly on a phone; describe the action
instead.

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
- **iPhone/iPad Safari:** Share → Add to Home Screen → Add, with Share placed for the device
  and hints where people get stuck (Share hidden behind **More** in Safari's compact layout,
  Add to Home Screen further down the action list). Chrome and Edge on iOS get their own
  first step, with Safari as the fallback; other iOS browsers get **Copy address** (with
  `?install`, so Safari shows the steps on arrival).
- **Android without a prompt** (Firefox, Samsung Internet, Edge, or Chrome before it offers
  one): that browser's menu and the exact name of its item (Add to home screen / Install app,
  Add app to Home screen, Add page to → Home screen, Add to phone).

Steps are written with markers that `stepSegments` turns into pieces: `[icon:Label]` is what to
tap, drawn as a button-like chip with the icon people look for (Share, ⋯ More, ⋮ Menu, ≡ Menu,
Add); `**word**` is emphasis; a step's `hint` is a muted line under it.

`InstallCard` shows this once per device at the bottom of the screen (dismissal is kept in
local storage). The pairing QR code's link has `?install`, which shows it again on arrival and
is removed from the address. Settings → Remote Access on the phone has a **This device** section
with the same help. In the installed app's first launch, the card instead offers the badge
permission when the Mac has chosen badge plugins (iOS only asks from an installed app).

**Service worker** (`sw.js`, registered only on remote clients in a secure context):

- hashed build files under `/assets/` come from the cache once fetched; when a page with a new
  main script arrives, the asset cache starts over, so old builds don't pile up;
- the page itself is network-first, falling back to the cached copy (whose connection banner
  explains the Mac can't be reached) or, with nothing cached, a static "Can't reach your Mac"
  page. Gateway errors count as unreachable: Serve answers 502/504 while nothing listens
  behind it, and ToolBelt 503 while it can't read the owner;
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
   connection, and indefinitely before the page's first connection or while the pairing screen
   shows. The first connection fetches the plugin list again if it hasn't arrived.

Until the page has reached the Mac once (a fresh start, often from the home screen), a start
screen covers the app, which has no data yet: blank, then "Connecting to your Mac…" after
800 ms; if an attempt fails, "Can't reach your Mac" with what to check (the Mac awake, ToolBelt
running with remote access on, Tailscale connected on both devices) and **Try again**, while it
keeps retrying. The app's "no plugins installed" state appears only once the Mac has sent its
plugin list. After that first connection, the banner reports reconnecting, "Can't reach your
Mac" and remote access off (both in red, with **Retry now**), and the Disconnect dialog; an
unpaired connection shows the pairing screen.

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
cloud relay, a native iOS app and MCP clients. ToolBelt keeps Tailscale's identity headers as
the first gate and adds pairing for the owner's own devices, without scopes: a paired device has
full control. Borrowed from it: the secret in the QR link's fragment, the Serve-based publishing, the
`/.well-known/` reachability probe, never touching a rule that isn't ToolBelt's, running the
CLI only while needed, and the reconnect policy.
