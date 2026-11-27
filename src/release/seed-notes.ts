// The pull request description `bun run seed:update` opens: what the bundled SDK Explorer becomes,
// what was checked, and that nothing is published.

export type SeedNotes = {
  repo: string;
  tag: string;
  version: string;
  /** The version bundled before, read from seed.config.json's URL; null when it can't be read. */
  previous: string | null;
  asset: string;
  sha256: string;
};

/** The version in a seed URL (`…/releases/download/<tag>/<id>-<version>-<target>.tar.gz`). */
export function seedVersion(url: unknown): string | null {
  if (typeof url !== "string") return null;
  return /\/releases\/download\/v?([0-9][^/]*)\//.exec(url)?.[1] ?? null;
}

export function seedNotes(n: SeedNotes): string {
  const release = `https://github.com/${n.repo}/releases/tag/${encodeURIComponent(n.tag)}`;
  const from = n.previous && n.previous !== n.version ? `, replacing ${n.previous}` : "";
  return [
    `Bundles SDK Explorer **${n.version}** ([${n.tag}](${release})) as the app's seed${from}.`,
    "",
    `- \`seed.config.json\` points at \`${n.asset}\`, SHA-256 \`${n.sha256}\`.`,
    `- \`bun run seed:update --tag ${n.tag}\` checked the published release's descriptor, the archive's size and hash, and its manifest (id \`sdk-demo\`, repository, version) before writing it.`,
    "",
    "This publishes nothing: the bundled Explorer ships with the next app release. Add a CHANGELOG line under Unreleased if the new Explorer changes what people see.",
    "",
  ].join("\n");
}
