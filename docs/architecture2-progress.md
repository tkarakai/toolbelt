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
