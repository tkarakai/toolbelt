# Architecture v2 implementation evidence

Implementation assigned 2026-11-10. Root coordinates/reviews; host_sdk owns host/SDK/tester; processes owns Processes and the external SDK demo; processes and upkeep agents own their respective repositories.

The user confirmed another session occupies the canonical `feat/architecture2` checkout and authorized this clean `feat/architecture-v2` checkout. Implementation PR targets `feat/architecture2`; canonical checkout remains untouched.

## Milestone 1: SDK candidate

Protocol 1, package format 1, diagnostic SDK `0.2.0-dev.1`. Existing declarative APIs preserved; adds hello/ready, prepare/shutdown, package paths/assets, migration helper, runtime validators and fake host. Typecheck passed after frozen install and Electrobun prepare. Candidate is provisional development output; host installer/runtime integration and comprehensive tests remain pending.

## Current gate matrix (review-fix checkpoint)

| Gate | Evidence / remaining work |
| --- | --- |
| Complete plugin extraction/parity | Independent packages, behavior tests, copied-v1 data rehearsals and SDK4 declared native handoff pass; all three plugin/demo PRs green |
| SDK/package validation | Published immutable SDK dev.4; protocol1/package1, nested schemas, archive/asset limits and adversarial tests pass |
| Generic installer/GitHub resolution | All3 public packages pass resolve/hash/extract/prepare/probe/final-ready/disable/remove; source binding, target, digest, immutable-version and approval candidate lease guards pass |
| Runtime containment | Negotiation/ready, bounded frames/render/logs, crash backoff/quarantine, owned-group TERM/KILL survivor regression and byte verification on every activation/restart pass |
| Migration/recovery | Durable staged trees/snapshots/rename directories, six fault boundaries and four actual SIGKILL recovery points pass. Actual service + real child schema1/7 → schema2/99 → historical schema1/7 restoration passes; missing snapshot refuses without stopping current child |
| Plugin manager | Actual RPC/store/browser install3, channel/schedule, cancellation, confirmed cleanup navigation, retain/delete, stale recovery and crash isolation pass23 checks; runtime logs/update errors attributed |
| Standalone tester/native | Shared renderer/runtime/native shell; native screens/quick/keyboard/theme/zoom/motion/Escape/blur/profile tests pass. Signed real-app AX automation limitation documented; actual Chromium wide inspector/tool-detail and414px visual rerun pass with root/body414 |
| Demo/assembly | Only hash-pinned removable prebuilt external demo seed; removed/disabled seed persists; no plugin source/build dependencies in host |
| Build/release artifacts | Source7208f26 host/tester builds, real-app signing, tar and mounted DMG checks pass; immutable local copies and hashes below |
| App updater safety | Real signed-DMG one-hop0.1.0→0.1.1 passes hash/signature/swap/relaunch/data retention; incompatible and busy plugins defer with original PIDs/app intact; bad SHA refuses; isolated HOME/SHELL preserved |
| CI/review | PR16 all4 green at892f5cc; review-fix checkpoint CI and coordinator re-review remain next. User testing/review and deferred docs cleanup remain open; no main merge or stable release |

## Current immutable runtime pins

| Artifact | Source/release | SHA256 |
| --- | --- | --- |
| Processes | 793142c849fd3281db67030d147c311f5907f457 / architecture2-793142c | 04194342a9da8ddccc172d3d52bcb845c80209bac2fd2f32d7e4a47ea3a5465a |
| Upkeep | c8d8c1f32412a5a4221e0e608a398404a7ec7c3d / architecture2-eval-c8d8c1f | 4ab77de0088caaff7dcb034fe63ace2d1926ed4a210c98fc25a309c7aa596a19 |
| SDK demo seed | c89e2e9926d8bbb1c677209081b2874d1c034248 / architecture2-c89e2e9 | e6d9e8694c8713f6737b30e8f1550776ad695c6321a429c1e0bf0f5a008e30d0 |

Later plugin documentation-only heads are distinct from runtime pins. These supersede historical milestone candidates below.

No stable releases, main merges, installed-app replacement, real data import or real software updates are authorized or performed.

## Deferred documentation gate

After implementation is fully proven and after the user's review, before the user's main merge: remove progress/planning/reasoning/redesign history across repositories and replace it with as-is `architecture.md`, current maintenance instructions and plugin author/update documentation. Preserve evidence until review; this cleanup is explicitly deferred.

## Milestone 2: runtime and package installer candidate

Generic package stage/hash/ustar validation, GitHub release descriptor resolution, registry runtime discovery, handshake/ready/prepare, bounded transport, user trust manager UI and versioned asset routing implemented. `bun run typecheck` passes. `bun test test/packages.test.ts test/host.test.ts test/sdk.test.ts test/protocol.test.ts`: 21 cases passing. Upkeep independently exercised real published archive through resolution/staging/migration/probe/final activation, all 6 surfaces, busy-operation refusal, disable/re-enable/removal with retained data.

Provisional gaps remain: exhaustive nested UI validation and adversarial matrix, journal validation/fsync/fault recovery, package leases/retention/downgrade flows, periodic update UX, generic assembly/demo seed, tester/native validation and CI. This checkpoint is for integration, not an acceptance claim.

Plugin candidate pins: Processes commit `309ac877658a56616ee6de1229d79f686a10c6da`, prerelease `architecture2-309ac87`, sha256 `0e846395b9001200c6783b7f7f987ebacc664f288c5b5eb66d35f6eda2653ff0`; Upkeep prerelease `architecture2-eval-20be059`, sha256 `c5ca2835add9d98e87416129266e2d2a3174c286c7634505c46cadbafa856c98` (33878 bytes). Earlier non-ustar candidates are superseded.

## Milestone 3: generic assembly

Processes/Upkeep implementation, assets and business tests removed from Toolbelt after both independently built archives passed real generic installer/runtime execution. The hidden conversation parser tests were transferred to Processes (68 tests/384 assertions). App assembly downloads only a hash-pinned prebuilt demo seed; it executes no plugin build commands. Host terminal source compilation removed; plugin terminal artifacts belong to Processes. SDK remains a host output. Generic preview uses an independent v2 profile and registry.

`bun test`: 327 pass, 0 fail, 2941 assertions across 13 files (before added fault tests). `bun run typecheck` and `bun run views` pass. Further mandatory acceptance gates remain pending; UI/native/tester and CI are not yet proven.

## Milestone 4: integrated manager/tester and fault coverage

Merged additive tester PR #15 and manager UI PR #17 into implementation PR #16. Actual typed manager adapter uses one shared production service for native/preview/tester. It pushes lifecycle/error/log snapshots, verifies compatible approval tokens (10 minute lifetime), persists channel and six-hour notify-only checks, permits cancellation at download boundaries, offers separate checked data deletion, routes CLI cleanup to the plugin's confirmed Settings screen, and revalidates schema-compatible or matching-snapshot recovery. Three historical selections/snapshots retained; live PID leases pin opaque CLI packages. Package bytes are rechecked against approved cached archives immediately before execution. Registry and journals fsync before/after atomic rename. Malformed journals are quarantined.

Fault tests cover hash/metadata/path/version compatibility, traversal/absolute/duplicate/link/special/truncated archives, bounded decompression, malformed/deep renderer trees and decorated cells, premature messages/unterminated frames/flooding, prepare refusal without stopping old process, failed candidate/final activation, concurrent IDs, schema migration failure/timeout, snapshot-backed downgrade, interrupted prepared/promoting/committed journals, and live helper lease retention. `bun run typecheck` and full `bun test`: **364 pass, 0 fail, 3058 assertions, 19 files**.

Native tester builds and source-independent copied apps exercised by plugin agents. QA found and corrected embedded sidebar containment, viewport-relative frame sizing, missing native Edit/Settings menu, null quick-view height and invalid pre-layout/negative tray geometry. Shared position fallback is tested against actual native bounds. Upkeep reports real native list/380×520 quick view visible and Escape transitions working on build 6. Final native keyboard/theme/narrow/blur evidence and full host app replay remain in progress; no final acceptance claim yet.

Historical pins at milestone4 (superseded above): demo seed: `architecture2-a92399e`, SHA256 `1175e2e0c1c04a4234aaa0237049d80b657de00bbeabc48771216830bd47698b`, 7771 bytes, SDK dev.2, optional capability fallback/payload/migration coverage. Processes evaluation: `architecture2-793142c`, SHA256 `04194342a9da8ddccc172d3d52bcb845c80209bac2fd2f32d7e4a47ea3a5465a`, 349645 bytes; stable launcher helper leases and confirmed cleanup screen. Upkeep probe-startup safety was subsequently fixed and packaged in c8d8c1f: staged probes do not schedule external updates or read login startup files. Host now supplies `TOOLBELT_LIFECYCLE_MODE=probe|active`, exposed as SDK Context.mode in dev.3.

## Latest source checkpoint verification

`bun run typecheck`: pass. `bun test`: **371 pass / 0 fail / 3086 assertions / 21 files**.
All tooling entrypoints also bundle with `bun build scripts/*.ts --target bun` without executing release actions. New regressions include seed persistence, active-view reattachment after package replacement, timestamp/prototype safety, native handoff metadata and cross-origin development-control rejection. SDK dev.4 adds generic declared native handoff intent, eliminating host inspection of Processes action names. This historical checkpoint preceded the now-published SDK4 plugin metadata roll-forward.

Independent actual manager acceptance report: `/tmp/toolbelt-accept-67c57f5/REPORT.md` (23 checks). Runtime failure logs and update-check errors now include plugin/repo attribution; real historical recovery through the actual service and real child migrations subsequently passed (see latest evidence below).

## Review corrections and final independent evidence

The coordinator's five findings are corrected: parent exit no longer skips descendant termination; cached approved bytes are verified for enable/restart; recursive file/directory fsync precedes committed journal and previous-data deletion; malformed journals are quarantined individually; explicit data deletion records initialization separately from package identity. Interrupted deletion/reinitialization also recover safely. Candidate leases preserve multiple reviewed versions until approval expires or is discarded; successful install and canceled review release leases.

`bun run typecheck` and full `bun test`: **389 pass / 0 fail / 3167 assertions / 24 files**. Focused actual-child integrity and owned-group tests pass. `test/power-recovery.test.ts` SIGKILLs a separate installer at previous rename, candidate promotion, registry commit and journal commit, then recovers from a fresh manager. Tooling entrypoints bundle successfully without executing release actions.

Actual manager evidence: `/tmp/toolbelt-accept-67c57f5/REPORT.md`. Real schema child/migration restoration evidence: `/tmp/toolbelt-schema-restore-result.json` (matching snapshot restores counter7 rather than current99, missing snapshot preserves PID88448). Real signed-DMG updater evidence: `/tmp/toolbelt-updater-rehearsal-state.json` (0.1.0PID51557→0.1.1PID53053; compatibility refusal before download; busy refusal preserves app/plugin PIDs; bad-SHA refusal; no remaining owned mounts/staged directories).

Final renderer evidence lives in Processes and demo `docs/browser-acceptance.md`: actual Chromium414×896, inner/root/body414, wrapped toolbar, scrollable tabs, readable primary text,382px dialog;1440px inspector340px and expanded conversation Input/Output screenshots. App SHA256 `c1947ec25d1764851e76ebf7e0f16119fbb54a17f3c24df1786c7ad93bc0a97f`; Render SHA256 `dc55cb93f08e66ff31f47f0087c243f410fe6a5a2f32038a1a4537a4f8da94bc`. All agent-owned native/browser test sessions were closed.

## Source-exact evaluation artifacts

Built from clean implementation source `7208f2658f376b946dc12f608476be00df8a47c0` with Bun1.4.4 on macOS arm64. `bun run build`, `bun run dmg` and `bun scripts/build-tester.ts` pass. Both disk images were mounted read-only and checked for bundle identity, version0.1.0 and strict ad-hoc signature, then detached. Tester distribution contains the real native app rather than Electrobun's self-extracting stub. SDK dev.4 remains the already-published frozen asset.

Immutable local copies are at `/tmp/toolbelt-v2-7208f26-artifacts/`:

| File | Bytes | SHA256 |
| --- | ---: | --- |
| Toolbelt-0.1.0-arm64.dmg | 34055962 | ebdeaf4c417c3891e1ac166b79b4ae94e7a9ef1d36718b9a668f65fd78159b46 |
| Toolbelt-Plugin-Tester-0.1.0-arm64.dmg | 34079258 | 9b67ccd574aed6acf66fb66160fabcd1a441d4051e08600071ef7f6cae9992bc |
| Toolbelt-Plugin-Tester-0.1.0-macos-arm64.tar.gz | 44378776 | e2ed93b913f188118f56fbc221a278e46de5f93d0527b9f3f0a3a495d39937ef |

Host update bundle `artifacts/stable-macos-arm64-Toolbelt.app.tar.zst`: SHA256 `d98ed85c4e882e0a9c74d19bb1b1a82752cdd122f996729dc69bc92ff6bfb331`. Build logs: `/tmp/toolbelt-final-host-build.log`, `/tmp/toolbelt-final-host-dmg.log`, `/tmp/toolbelt-final-tester-build.log`. These are evaluation outputs, with no stable release or installed-app replacement.
