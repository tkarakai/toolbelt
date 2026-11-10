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
