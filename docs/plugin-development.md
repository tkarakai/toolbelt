# Plugin development mode

ToolBelt can test unreleased plugin archives itself. Development mode is a separate session of
the same app with its own plugin profile. Released plugins never share a session with
development plugins, and nothing installed in development mode can be promoted into the
normal profile: a plugin becomes installable there only through a GitHub release.

This is the only supported way to test unreleased plugins; it replaces the former standalone
Plugin Tester app. It requires ToolBelt 0.4.0 or later.
The browser preview (`bun run preview`) runs a development profile when started with
`TOOLBELT_DEVELOPMENT_PROFILE`; it cannot relaunch, so it only reports mode switches.

`src/bun/development.ts` owns profiles, local archives, watch, diagnostics and the request
controller shared by the app, preview and debug channel. `src/ui/Development.tsx` is the
Settings UI.

## Modes

ToolBelt runs in exactly one mode per process:

| | Normal mode | Development mode |
| --- | --- | --- |
| Plugin profile | Normal profile (`configDir`) | `<configDir>/development/<name>/` |
| Plugin sources | GitHub releases, bundled seed | Local archives and GitHub releases |
| Scheduled plugin update checks | Every six hours | None |
| App updater | Enabled for stable builds | Disabled (manual check only, no install) |
| SDK Explorer seed | Installed once per profile | Not installed |
| Settings (theme, shortcut) | `settings.json` in `configDir` | Same file, shared with normal mode |
| Renderer preferences | Namespaced by profile | Namespaced by the development profile |

`TOOLBELT_DEVELOPMENT_PROFILE=<name>` selects development mode at launch. Names use letters,
digits, underscores and dashes (up to 64 characters). Without the variable ToolBelt starts in
normal mode, so quitting or rebooting always returns to the released plugins.

Settings and the shortcut are shared because only one mode runs at a time: the development
session owns the global shortcut and menu-bar icon while it runs. Plugin registry, packages,
caches, managed data, backups, transactions and leases all live inside the development
profile directory.

## Switching modes

**Settings → Plugins → Plugin development** relaunches into a named profile; existing profiles
are offered by name. In development mode that group moves to the top of the Plugins tab with
**Return to normal mode**, which the app menu also offers. The sidebar footer, popover header
and an amber menu-bar glyph show the active profile, and the window title names it.

A switch is a relaunch of the same app bundle (`open -n` once the current process exits), so
ToolBelt Dev started by `bun run dev` relaunches its built bundle detached from the terminal:

1. Every running plugin is asked to prepare with reason `mode-switch` (an app update uses
   `host-upgrade`). Plugin operations are held while the switch is in progress, and a switch
   waits for an app update in progress.
2. If any plugin refuses or fails to prepare, the switch is cancelled. Plugins that had
   already prepared are reactivated; the refusing plugin keeps running untouched.
3. Otherwise a new instance is started with the same `TOOLBELT_*` environment, plus or minus
   `TOOLBELT_DEVELOPMENT_PROFILE`, and the current instance quits. Quitting stops owned
   process groups as usual; observed processes and independent terminal jobs survive.

While development mode runs, released plugins are stopped: their scheduled work does not run
until normal mode starts again from their own retained state.

## Local archives

In development mode, **Open archive** and **Open and watch** take:

- the full path of a built `.tar.gz` plugin archive. **Choose…** opens the native file picker
  in the folder of the path already typed when it exists (or that folder itself), else in the
  last chosen folder, and prefills the publisher from the archive's manifest,
  read with the bounded extractor into a scratch folder; nothing is installed or executed,
- the publisher repository (`owner/repo`) that must match the manifest's `repo`,
- an explicit approval to execute that publisher's code with the user's privileges.

The archive goes through the production path: bounded archive validation, compatibility and
publisher checks, data initialization or migration, staged probe and the readiness
transaction. Nothing is built, and no dependency installation runs. The local SHA-256
identifies the bytes; it is not authentication.

Local installs are recorded with `local: true` in the development registry and are never
included in update checks.

### Source archives and watching

Each local plugin remembers the archive it was last installed from, its publisher and whether
it is watched, in `<profile>/development-sources.json`. Its card under **Installed Plugins**
shows that archive with an **Install rebuilds automatically** switch. While the switch is on,
changes to the archive file reinstall it (after a 300 ms settle) through the same path,
without asking again: turning the switch on, or choosing **Open and watch**, is the approval.
Build the plugin in its own repository; only the archive file is watched.

Opening an archive keeps the plugin's existing watch choice and moves the watch to the new
path. Watches stop when the app quits or switches modes and resume when the same development
profile opens again; a watch whose folder is gone is turned off and logged. Removing the plugin
from Installed Plugins stops its watch instead of reinstalling it on the next rebuild.

### Rebuilding the same version

Normal profiles reject different bytes for an already installed version. Development
profiles accept a **local** archive with the same version and different bytes: the package is
stored under its own `<version>-<hash>` directory and activated through the normal upgrade
transaction, keeping managed data (the same schema needs no migration). Each replacement is
recorded in the diagnostics. The `PackageManager` refuses local archives entirely unless it
was constructed for a development profile, so normal profiles never take this path.

### Reset and restart

A card's **Reload** is the normal prepare-aware restart. **Reset data…** in a local plugin's
actions menu deletes its managed data after confirmation and reinstalls it from its recorded
archive, so it initializes fresh with the same watch choice. If that archive no longer exists
the plugin stays removed and its record is forgotten. Use separate profiles for independent
scenarios or upgrade tests; installing an older then a newer archive in one profile exercises
migrations.

## Diagnostics

Development mode keeps one global record for the session, not one per plugin: a bounded log (200 entries, 16 KB per entry) of archive loads,
installs, same-version rebuilds, watch events, resets, errors, plugin stderr and every
protocol message in both directions. Plugin entries carry the plugin ID. It lives in the Plugin
development group, read only while its disclosure is open; each card's activity button keeps
showing that plugin's recent lifecycle events.

## Automation

When the debug channel is enabled (`TOOLBELT_DEBUG_PORT`, see [maintenance.md](maintenance.md#debugging)),
`GET /state` includes the mode, profile and each local plugin's source archive and watch, and `POST /development` accepts JSON:

| Operation | Parameters | Mode |
| --- | --- | --- |
| `state` | — | Both |
| `choose` | optional `archive` (typed path to start from); returns `chosen` | Development |
| `enter` | `profile` | Normal |
| `exit` | — | Development |
| `load` | `archive`, `repo`, `approved: true`, optional `watch: true` | Development |
| `watch` | `id`, `watching` (true or false) | Development |
| `reset` | `id` (reinstalls from the recorded archive; returns `installed`) | Development |
| `diagnostics` | — | Development |

Use an isolated `TOOLBELT_CONFIG_DIR`, a distinct debug port and scratch archives. `enter` and
`exit` relaunch the app and end the current debug server.

## Safety

Development profiles separate managed data, not authority: plugins still run as the user.
Use scratch files, fake feeds and disposable processes, and never exercise mutating process,
software-update or shell-install actions against real jobs, apps or dotfiles.
