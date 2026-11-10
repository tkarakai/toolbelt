# Architecture v2 implementation evidence

Implementation assigned 2026-11-10. Root coordinates/reviews; host_sdk owns host/SDK/tester/demo; processes and upkeep agents own their respective repositories.

The user confirmed another session occupies the canonical `feat/architecture2` checkout and authorized this clean `feat/architecture-v2` checkout. Implementation PR targets `feat/architecture2`; canonical checkout remains untouched.

## Milestone 1: SDK candidate

Protocol 1, package format 1, diagnostic SDK `0.2.0-dev.1`. Existing declarative APIs preserved; adds hello/ready, prepare/shutdown, package paths/assets, migration helper, runtime validators and fake host. Typecheck passed after frozen install and Electrobun prepare. Candidate is provisional development output; host installer/runtime integration and comprehensive tests remain pending.

## Current gate matrix (latest checkpoint)

| Gate | Evidence / remaining work |
| --- | --- |
| Complete plugin extraction/parity | Passed independent packages, behavior tests and copied-v1 data rehearsals; declarative native handoff metadata roll-forward pending |
| SDK/package validation | Protocol1/package1, runtime nested schemas, archive/asset limits and adversarial tests pass; final SDK dev.4 asset pending checkpoint publication |
| Generic installer/GitHub resolution | Real public packages for all3 repos pass resolve/hash/extract/prepare/probe/final-ready/disable/remove; source binding, target, digest and immutable-version guards implemented |
| Runtime containment | Negotiation, explicit ready, crash backoff/quarantine, frame/byte/render/log limits, owned process groups and bounded termination pass |
| Migration/recovery | Failure/timeout/final-ready rollback, parallel IDs, fsync journals, interrupted prepared/promoting/committed recovery, schema-aware snapshot restoration and helper lease retention pass unit/integration tests; successful historical restoration through actual manager UI pending |
| Plugin manager | Independent actual RPC/store/browser install3, channel/schedule, cancellation, cleanup navigation, retain/delete, stale recovery and crash isolation pass; diagnostic attribution fixes implemented |
| Standalone tester/native | Shared production renderer/runtime/native shell; all plugin screens/quick views/keyboard/theme/zoom/motion/blur/profile tests reported passing by agents. Exact signed real-app AX/screenshot automation blocked by platform association; DOM geometry passes; wide inspector/tool-detail browser visual recheck pending |
| Demo/assembly | Only verified prebuilt removable demo seed, no real plugin sources/tests/builds in host; removed/disabled demo persists across app updates (regression test pass) |
| Build/release artifacts | Host and tester build pass; real tester app extracted, versioned, ad-hoc signed and strictly verified; separate signed tar/DMG packaging implemented, final artifact rebuild pending |
| App updater safety | Actual incompatible-plugin preflight and busy Upkeep preparation preserve same PIDs/app bytes; final one-hop signed-DMG update with isolated HOME propagation in progress |
| CI/review | PR16 green at67c57f5, later checkpoint awaitingCI. Main merges/stable releases/user installation remain prohibited. User review and deferred documentation cleanup remain open |

## Current immutable runtime pins

| Artifact | Source/release | SHA256 |
| --- | --- | --- |
| Processes | 582cd7a0a15a6814eb8597006e069c1de3c5a749 / architecture2-582cd7a | 20029917a8c6f4d0406757d0b012cb8f46eb509df8d2860ca97f0b135e44df51 |
| Upkeep | c8d8c1f32412a5a4221e0e608a398404a7ec7c3d / architecture2-eval-c8d8c1f | 4ab77de0088caaff7dcb034fe63ace2d1926ed4a210c98fc25a309c7aa596a19 |
| SDK demo seed | 8e8fca9bae97ba073b6aa6472a749e8c1a5e0b8b / architecture2-8e8fca9 | 51a7d9845c24c4e55b71f68011b41f7708317b2ca48555952a8cd62ba57da44f |

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

Historical pins at milestone4 (superseded above): demo seed: `architecture2-a92399e`, SHA256 `1175e2e0c1c04a4234aaa0237049d80b657de00bbeabc48771216830bd47698b`, 7771 bytes, SDK dev.2, optional capability fallback/payload/migration coverage. Processes evaluation: `architecture2-582cd7a`, SHA256 `20029917a8c6f4d0406757d0b012cb8f46eb509df8d2860ca97f0b135e44df51`, 349645 bytes; stable launcher helper leases and confirmed cleanup screen. Upkeep probe-startup safety was subsequently fixed and packaged in c8d8c1f: staged probes do not schedule external updates or read login startup files. Host now supplies `TOOLBELT_LIFECYCLE_MODE=probe|active`, exposed as SDK Context.mode in dev.3.

## Latest source checkpoint verification

`bun run typecheck`: pass. `bun test`: **371 pass / 0 fail / 3086 assertions / 21 files**.
All tooling entrypoints also bundle with `bun build scripts/*.ts --target bun` without executing release actions. New regressions include seed persistence, active-view reattachment after package replacement, timestamp/prototype safety, native handoff metadata and cross-origin development-control rejection. SDK dev.4 adds generic declared native handoff intent, eliminating host inspection of Processes action names. Final package metadata roll-forward and current-source CI remain next steps.

Independent actual manager acceptance report: `/tmp/toolbelt-accept-67c57f5/REPORT.md` (23 checks). Runtime failure logs and update-check errors now include plugin/repo attribution; successful real historical recovery through UI remains separate from passing backend recovery tests.
