# toolbelt — notes for coding agents

Toolbelt is a macOS app (Electrobun: Bun main process + WKWebView, React + shadcn/ui) that hosts
plugins — independent TypeScript programs that describe their screens over a JSON-lines
protocol; Toolbelt renders them. See `README.md`.

## Workflow (required)

- **Never commit to `main` directly.** Branch (`feat/…`, `fix/…`), open a pull request, let CI
  pass, squash-merge. The PR title becomes the commit title on `main`. The `main` ruleset
  enforces this (`.github/settings/`).
- **One agent per checkout.** If `git status` shows changes you didn't make, stop and ask —
  another session may be working here.
- Add user-visible changes to `## Unreleased` in `CHANGELOG.md` in the same PR.
- Don't bump the version in feature PRs; that happens in a release PR.
- Workflow files: pin actions to full commit SHAs, keep `permissions` minimal. Only
  GitHub-owned actions, `oven-sh/setup-bun` and `zizmorcore/zizmor-action` are allowed.

## How it fits together

- `src/bun/` — the main process. `index.ts`: window, tray + popover, global shortcut, app menu,
  debug channel. `host.ts`: finds plugins (`toolbelt.json`), runs each with Bun, relays trees.
  No Electrobun imports in `host.ts`, so tests and `scripts/preview.ts` can use it.
- `src/shared/protocol.ts` — the plugin protocol (v0) and every UI node type. **Changing it
  changes what plugins can do**: update the renderer, the Showcase plugin and the tests with it.
- `src/sdk/` — the plugin side (`definePlugin`); will become a package.
- `src/ui/` — one React + shadcn/ui app for both surfaces: the window (`App.tsx`) and the
  popover (`Popover.tsx`, `index.html#popover`). `renderer/Render.tsx` maps nodes to components.
  `components/ui/` is shadcn's (add more with `bunx shadcn@latest add …`; it once rewrote
  imports to an npm package called `cn` — check the diff).
- `plugins/` — built-in plugins, bundled to `build-plugins/` by `scripts/build-plugins.ts`.
  `plugins/processes/`: `running/` (running, vendored as is — see its `VENDORED.md`; the build
  bundles `running-core.js` and the TUI `bin/running` next to the plugin), `paths.ts` (finds
  them; `RUNNING_CORE_SCRIPT` overrides the engine), `install.ts` (puts the TUI on PATH and the
  zsh hook in ~/.zshrc — every path derives from `TOOLBELT_PS_HOME`, else the real home: test
  only against temp homes, `test/processes-install.test.ts`), `tui.ts` (that Settings card),
  `core.ts` (running-core client), `model.ts` (grouping/sorting/search,
  pure — tested in `test/processes-model.test.ts`), `index.ts` (screens, dialogs, actions).
  Testing it touches the person's real processes: open dialogs, never save/stop/kill/focus.
- `src/ui/themes.ts` — palettes (light + dark each); `test/themes.test.ts` enforces WCAG AA for
  every text/background pairing. Add a theme there, and the test tells you if it's readable.
  Use the `selected` / `selected-foreground` tokens for selection, not `accent` (that's hover).
- `src/sdk/search.ts` — plugin search (substring or one typo, plus `highlight()` for the page).
- `src/bun/tray-highlight.ts` — keeps the menu bar icon highlighted via the ObjC runtime
  (Electrobun has no API); best effort, logs and gives up if the view tree changes.
- UI state that must feel instant (typing, selection, scroll) stays in the renderer; plugins
  get events (`search`, `sort`, action ids, `field`). `src/ui/lib/uistate.ts` keeps it per
  surface and saves it (localStorage), so tools come back as they were left.
- `src/ui/renderer/pure.ts` — layout decisions (which columns fit, action groups, detail
  sections, terminal appends, zoom steps) without React; tested in `test/renderer-pure.test.ts`.
  `Terminal.tsx` (xterm.js) and `Conversation.tsx` draw the `terminal` and `conversation` nodes.
- `src/ui/lib/zoom.tsx` — ⌘+ / ⌘- / ⌘0 (View menu commands); a component can take zooming over
  while it's on screen (`useZoomTarget`).
- `src/bun/file-icon.ts` — Finder's icons for `app:` / `file:` icon names (via JXA, cached in
  `<config>/cache/icons`).

## Motion (a core UX principle)

Things that appear, disappear, move or change size animate — never jump. The standard is
**200 ms** (`duration-200`; Tailwind's default transition duration is set to it in
`src/ui/index.css`), easing out. Use `tw-animate-css` (`animate-in fade-in-0 …`, `animate-out
…`) for enter/exit and `transition-*` for state changes; keep exits a little shorter (150 ms).
Examples to follow: the popover (`Popover.tsx`, the main process waits for its closing
animation before hiding the window), the details drawer (`Inspector` animates its width), tab
and tool switches (`App.tsx`), newly visible rows (`TableRow`), `ZoomIndicator`. Don't animate
what updates continuously (live values, sparklines) or the first paint of a long list. Reduced
motion (macOS setting) turns animations off globally.

## Working on the code

- `bun run typecheck`, `bun test`, `bun run build` (artifacts/). `bun run dev` launches the app;
  stop it before `bun run build` (they share Hutch's lock).
- Verify UI changes in a browser: `bun run preview` serves the built UI with the real plugins
  at http://localhost:5174 (`/#popover` for the popover; reload after changing the hash —
  the surface is picked at load). Drive and screenshot it with `chrome-devtools-axi`.
- Verify the real app without screen recording: `TOOLBELT_DEBUG_PORT=47811 bun run dev`, then
  `curl 127.0.0.1:47811/state` (`/popover`, `/hide`, `/window?plugin=…&screen=…`, `/close`),
  and `curl -X POST '127.0.0.1:47811/eval?target=window|popover' -d '<js expression>'`
  (`window.__tbEvent(plugin, surface, name, payload)` sends plugin events; `window.__tbPerf`
  holds render timings). A window behind others reports `document.hidden` and is throttled.
- If the person has `bun run dev` running, it holds Hutch's build lock: don't stop their app —
  copy the checkout elsewhere (`rsync -a --exclude /build --exclude /dist --exclude /.hutch
  --exclude /build-plugins --exclude /.git`) and run your copy there, with its own
  `TOOLBELT_DEBUG_PORT` and `TOOLBELT_CONFIG_DIR`.
- Global shortcuts: use `src/bun/hotkey.ts` (Carbon), not Electrobun's `GlobalShortcut` — that
  one silently needs Accessibility permission.
- Never kill, restart or type into the user's own processes or terminals while testing — the
  Processes plugin can stop processes; use the Showcase plugin to exercise actions.

## Bun

- Use `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <pkg>` — not node,
  jest/vitest, npm/yarn/pnpm or npx.
