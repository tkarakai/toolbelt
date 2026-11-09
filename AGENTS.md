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

## Bun

- Use `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <pkg>` — not node,
  jest/vitest, npm/yarn/pnpm or npx.
