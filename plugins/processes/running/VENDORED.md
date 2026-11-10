# Vendored: running

A copy of [running](https://github.com/tkarakai/running), **unmodified**, taken with `git archive`
from commit `c9d55727a7b38b4738b31608b8480c1eccebf8d0` (v0.8.0): `src/`, `package.json`,
`tsconfig.json`, `README.md`, `CHANGELOG.md`. (running has no LICENSE file; it's the same author.)

Re-sync (from the Toolbelt checkout's root, with running checked out at ~/dev/projects/running):

```sh
rm -rf plugins/processes/running/{src,package.json,tsconfig.json,README.md,CHANGELOG.md} && git -C ~/dev/projects/running archive HEAD src package.json tsconfig.json README.md CHANGELOG.md | tar -x -C plugins/processes/running
```

Then update the commit above, bring Toolbelt's `ink` / `yaml` versions in line with
running's `package.json`, and run `bun run plugins && bun test`.

How Toolbelt uses it (nothing here is edited for that):

- `scripts/build-plugins.ts` bundles `src/serve.ts` → `build-plugins/processes/running-core.js`
  and `src/main.tsx` → `build-plugins/processes/bin/running` (`#!/usr/bin/env bun`, minified), the
  way running's `scripts/build.ts` does: `__BUILT_WITH_BUN__` defined as the building Bun's
  version (the app ships that same Bun), and `react-devtools-core` resolved to
  `src/stubs/react-devtools-core.ts`. `init.zsh` comes in through Bun's text import.
- Toolbelt's `tsc` excludes this folder (running uses TypeScript 7 and its own settings).
- The dependencies (`ink`, `yaml`, `react`) come from Toolbelt's `package.json`.
