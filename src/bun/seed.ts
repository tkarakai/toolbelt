import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PackageManager, atomicJSON } from "./packages";
/** First-party bundled seed uses the identical validator/transaction installer, once per profile. */
export async function materializeSeed(manager: PackageManager, seed: string) {
  const registry = manager.registry();
  if (registry.seeded || !existsSync(join(seed, "seed.json"))) return;
  const metadata = JSON.parse(readFileSync(join(seed, "seed.json"), "utf8"));
  const candidate = await manager.stage(
    new Uint8Array(readFileSync(join(seed, "demo.tar.gz"))),
    metadata.sha256,
    metadata.repo,
  );
  // Tombstones and disabled/installed selections survive app upgrades. Seeds never replace versions.
  if (!registry.plugins[candidate.manifest.id])
    await manager.install(candidate, true);
  const latest = manager.registry();
  latest.seeded = true;
  atomicJSON(join(manager.root, "plugins/registry.json"), latest);
}
