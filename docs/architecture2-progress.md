# Architecture v2 implementation evidence

Implementation assigned 2026-11-10. Root coordinates/reviews; host_sdk owns host/SDK/tester/demo; processes and upkeep agents own their respective repositories.

The user confirmed another session occupies the canonical `feat/architecture2` checkout and authorized this clean `feat/architecture-v2` checkout. Implementation PR targets `feat/architecture2`; canonical checkout remains untouched.

## Milestone 1: SDK candidate

Protocol 1, package format 1, diagnostic SDK `0.2.0-dev.1`. Existing declarative APIs preserved; adds hello/ready, prepare/shutdown, package paths/assets, migration helper, runtime validators and fake host. Typecheck passed after frozen install and Electrobun prepare. Candidate is provisional development output; host installer/runtime integration and comprehensive tests remain pending.

## Required gates

| Gate | State |
| --- | --- |
| Complete plugin extraction/parity | In progress in plugin repos |
| SDK package/validation/contracts | Candidate; adversarial tests pending |
| Generic installer/GitHub resolution | Pending |
| Runtime negotiation/limits/isolation | Pending |
| Upgrade migration/recovery | Pending |
| Plugin manager/runtime UI | Pending |
| Standalone tester/native validation | Pending |
| Removable external demo | Pending |
| Generic app assembly/no plugin sources | Pending, extraction must validate first |
| Artifact pins/clean execution | Pending |
| PR CI and final user testing | Pending |

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

Current demo seed: `architecture2-a92399e`, SHA256 `1175e2e0c1c04a4234aaa0237049d80b657de00bbeabc48771216830bd47698b`, 7771 bytes, SDK dev.2, optional capability fallback/payload/migration coverage. Processes evaluation: `architecture2-582cd7a`, SHA256 `20029917a8c6f4d0406757d0b012cb8f46eb509df8d2860ca97f0b135e44df51`, 349645 bytes; stable launcher helper leases and confirmed cleanup screen. Upkeep pending an additional probe-startup safety fix: staged probes must not schedule external updates. Host now supplies `TOOLBELT_LIFECYCLE_MODE=probe|active`, exposed as SDK Context.mode in dev.3.
