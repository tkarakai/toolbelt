import { CAPABILITIES, type PackageManifest } from "../shared/package";
import { PROTOCOL_VERSION } from "../shared/protocol";
import type { PluginInspection } from "../shared/plugin-inspection";

/** True when `version` satisfies `range`; malformed ranges count as unmet instead of throwing. */
function satisfies(version: string, range: string) {
  try {
    return Bun.semver.satisfies(version, range);
  } catch {
    return false;
  }
}

/**
 * Compatibility facts for an installed plugin, compared with this host. Reads only the
 * installed manifest and what the running plugin reported; never contacts GitHub or runs code.
 */
export function inspectPlugin(
  manifest: PackageManifest,
  context: { hostVersion: string; sdk?: string; bunVersion?: string; platform?: string },
): PluginInspection {
  const supported = CAPABILITIES as readonly string[];
  const bunVersion = context.bunVersion ?? Bun.version;
  const platform = context.platform ?? `${process.platform}-${process.arch}`;
  const capability = (id: string) => ({ id, supported: supported.includes(id) });
  const required = manifest.capabilities.required.map(capability);
  const optional = manifest.capabilities.optional.map(capability);
  const checks = {
    protocol: manifest.protocol === PROTOCOL_VERSION,
    host: satisfies(context.hostVersion, manifest.requires.host),
    bun: satisfies(bunVersion, manifest.requires.bun),
    platform: manifest.requires.platforms.includes("portable") || manifest.requires.platforms.includes(platform),
    capabilities: required.every((c) => c.supported),
  };
  return {
    compatible: Object.values(checks).every(Boolean),
    protocol: { plugin: manifest.protocol, host: PROTOCOL_VERSION, ok: checks.protocol },
    host: { requires: manifest.requires.host, version: context.hostVersion, ok: checks.host },
    bun: { requires: manifest.requires.bun, version: bunVersion, ok: checks.bun },
    platforms: { declared: manifest.requires.platforms, current: platform, ok: checks.platform },
    capabilities: { required, optional },
    agentAccess: manifest.agent?.access,
    sdk: context.sdk,
    data: { schema: manifest.data.schema, supports: manifest.data.supports },
    screens: manifest.screens.length,
    quickView: !!manifest.quickView,
    command: manifest.cli?.command,
  };
}
