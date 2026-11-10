# Vendored: Toolbelt Upkeep

Source: [tkarakai/toolbelt-upkeep](https://github.com/tkarakai/toolbelt-upkeep), commit
`5ee37e24b766f690aed005ae2f3863ad2b86eaf4` (the initial implementation in PR #1).
The source repository remains the home for plugin development. It has no LICENSE file
and shares Toolbelt's author.

This snapshot includes `index.ts`, `ui.ts`, `lib/`, `providers/`, `sdk/`, `test/`,
`toolbelt.json`, `README.md`, and `docs/design.md`. The SDK is the upstream plugin's own
vendored protocol v0 SDK; it remains compatible with Toolbelt's current protocol.
No extra runtime dependencies or network downloads are needed to build it.

`scripts/build-plugins.ts` picks it up like the other built-in plugins and bundles it to
`build-plugins/upkeep/{index.js,toolbelt.json}`. Electrobun copies that directory into the
app. Plugin data stays in the host-provided `TOOLBELT_DATA_DIR`; fresh data watches nothing.

To refresh from an upstream checkout, archive the paths above at an explicit commit into
this directory, update this commit reference, reapply the patches below, then run
`bun run typecheck`, `bun test`, and `bun run build`. Test using a scratch
`TOOLBELT_CONFIG_DIR`, never by updating installed software. Toolbelt's tests include the
upstream tests and a bundled-plugin host test in `test/upkeep-integration.test.ts`.

Local patches:

- Correct the manifest repository link and the entrypoint's design-document reference.
- Share the bulk-update eligibility rule between the toolbar and event handler. Exclude
  major upgrades, password-requiring items, and apps (which need individual review before
  they may be quit). The original handler could include major upgrades absent from its
  confirmation. Individual review and automatic-update policies remain available.

- Discover rows expose Stop watching when watched, so Enter reverses Watch in place.
