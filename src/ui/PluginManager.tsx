import { useEffect, useState } from "react";
import type { Installed } from "../bun/packages";
import { rpc } from "./lib/store";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./components/ui/card";
export function PluginManager() {
  const [installed, setInstalled] = useState<Installed[]>([]),
    [repo, setRepo] = useState(""),
    [release, setRelease] = useState(""),
    [prerelease, setPrerelease] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [candidate, setCandidate] = useState<
    | {
        token: string;
        id: string;
        name: string;
        version: string;
        repo: string;
        hash: string;
      }
    | undefined
  >();
  const run = async (
    params: Parameters<typeof rpc.request.pluginManager>[0],
  ) => {
    setBusy(true);
    setError("");
    try {
      const result = await rpc.request.pluginManager(params);
      if (result.error) setError(result.error);
      if (result.installed) setInstalled(result.installed);
      if (result.candidate) setCandidate(result.candidate);
      if (params.operation === "install" && !result.error)
        setCandidate(undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run({ operation: "list" });
  }, []);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Plugins</CardTitle>
        <CardDescription>
          Install prebuilt plugins from a public GitHub repository. Updates
          require your approval.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="GitHub repository"
            placeholder="owner/repository"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
          <Input
            aria-label="Release tag (optional)"
            placeholder="Release tag (optional)"
            value={release}
            onChange={(e) => setRelease(e.target.value)}
          />
          <label className="text-sm">
            <input
              type="checkbox"
              checked={prerelease}
              onChange={(e) => setPrerelease(e.target.checked)}
            />{" "}
            Allow prereleases
          </label>
          <Button
            disabled={busy || !repo}
            onClick={() =>
              void run({
                operation: "resolve",
                repo,
                release: release || undefined,
                prerelease,
              })
            }
          >
            Review release
          </Button>
        </div>
        {busy && <p className="text-sm text-muted-foreground">Working…</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive break-words">
            {error}
          </p>
        )}
        {candidate && (
          <div className="space-y-2 rounded-lg border p-4 animate-in fade-in-0 duration-200">
            <p>
              {candidate.name} {candidate.version} · {candidate.repo}
            </p>
            <p className="text-sm">
              This publisher's plugin and migrations run with your user
              privileges, including access to files, processes and network.
              Checksums verify downloaded bytes; they do not establish trust.
            </p>
            <p className="break-all font-mono text-xs">
              SHA-256 {candidate.hash}
            </p>
            <Button
              disabled={busy}
              onClick={() =>
                void run({ operation: "install", token: candidate.token })
              }
            >
              Trust publisher and install
            </Button>
            <Button variant="ghost" onClick={() => setCandidate(undefined)}>
              Cancel
            </Button>
          </div>
        )}
        {installed.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-center gap-2 border-t pt-3"
          >
            <div className="min-w-0 flex-1">
              <p>
                {p.manifest.name} {p.version}
              </p>
              <p className="text-xs text-muted-foreground break-all">
                {p.repo} · {p.enabled ? "Enabled" : "Disabled"}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run({ operation: "enable", id: p.id, enabled: !p.enabled })
              }
            >
              {p.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setRepo(p.repo);
                void run({
                  operation: "resolve",
                  repo: p.repo,
                  prerelease: p.channel === "prerelease",
                });
              }}
            >
              Check update
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Remove plugin? Data is retained. Any separately installed CLI or shell hook needs cleanup through the plugin before removal.",
                  )
                )
                  void run({ operation: "remove", id: p.id });
              }}
            >
              Remove
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
