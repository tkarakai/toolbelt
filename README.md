# ToolBelt

ToolBelt is a macOS app for independently installed tools. Each plugin runs as a Bun
process and describes its screens with declarative UI nodes. ToolBelt renders those nodes
with React and shadcn/ui in its main window and menu-bar popover.

Open **Settings → Plugins**, enter a public GitHub repository, review its release and
publisher, and approve installation. Plugins can be installed, enabled, disabled, updated
and removed without restarting the app. Updates are checked every six hours and require
approval. Removal keeps plugin data unless you explicitly choose deletion.

A fresh profile includes the removable SDK Explorer. [Processes](https://github.com/tkarakai/toolbelt-ps)
and [Upkeep](https://github.com/tkarakai/toolbelt-upkeep) are installed separately. Processes
owns its `running` terminal command and shell integration; ToolBelt does not install them
implicitly. Plugins execute with your user privileges; process isolation is not a security
sandbox.

## Manual installation

1. Download `Toolbelt-<version>-arm64.dmg` from the official
   [GitHub releases](https://github.com/tkarakai/toolbelt/releases/latest).
2. If updating, quit ToolBelt completely, including its menu-bar process.
3. Open the DMG and drag ToolBelt into Applications. Choose Replace if prompted.
4. Launch ToolBelt from Applications.
5. If macOS says “ToolBelt.app” Not Opened because Apple could not verify it is free
   of malware, click **Done**. Only if you trust the official download, open
   **System Settings → Privacy & Security**, scroll to **Security**, and click
   **Open Anyway** for ToolBelt. Authenticate if prompted, then click **Open**.
   If Open Anyway is missing, try launching ToolBelt again and return to these settings.

Updating keeps your settings, installed plugins and plugin data. See
[Apple’s guidance](https://support.apple.com/en-us/102445) for more about this macOS warning.

## Development

Use Bun 1.4.4 and macOS:

```sh
bun install --frozen-lockfile
bunx electrobun prepare
bun run typecheck
bun test
bun run dev
```

`bun run dev` launches ToolBelt Dev with a separate identity, profile and shortcut.
`bun run preview` serves the production UI and runtime at http://localhost:5174 with an
independent preview profile. `bun run build` produces the official app identity;
`bun run dmg` packages its signed app. Do not replace an installed app when testing builds.
`bun scripts/run-evaluation.ts` launches a copied build with temporary data and TUI-install
home. Stop only development processes you started; app development and builds share a lock.

## Documentation

- [Architecture](docs/architecture.md): runtime, storage, rendering, recovery and boundaries.
- [Plugin authoring and updates](docs/plugins.md): SDK, manifest, packaging and releases.
- [Plugin Tester](docs/plugin-tester.md): local archives, profiles and visual development.
- [Maintenance](docs/maintenance.md): checks, debugging and SDK/seed changes.
- [Releases](docs/releases.md): exact app, SDK and tester build/publish/recovery procedures.
- [Agent instructions](AGENTS.md): working conventions and verification requirements.

The app, SDK and standalone tester are released from this repository. Plugin archives,
helpers and terminal distributions are released by their owning plugin repositories.

Release commands prepare version PRs; merging a validated release PR authorizes CI publication. See [the release reference](docs/releases.md).
