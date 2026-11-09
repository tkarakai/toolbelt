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
- UI state that must feel instant (typing, selection, scroll) stays in the renderer; plugins
  get events (`search`, action ids, `field`).

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
- Never kill, restart or type into the user's own processes or terminals while testing — the
  Processes plugin can stop processes; use the Showcase plugin to exercise actions.

## Bun

- Use `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <pkg>` — not node,
  jest/vitest, npm/yarn/pnpm or npx.
