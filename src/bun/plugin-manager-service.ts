import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  PackageManager,
  atomicJSON,
  recoveryChoiceId,
  type Candidate,
} from "./packages";
import { PluginHost } from "./host";
import { resolveGithub } from "./plugin-github";
export type ManagerRequest = {
  operation: string;
  repo?: string;
  release?: string;
  prerelease?: boolean;
  token?: string;
  id?: string;
  enabled?: boolean;
  deleteData?: boolean;
  channel?: "stable" | "prerelease";
  operationId?: string;
  choiceId?: string;
};
/** One control plane shared by the native app and preview; never executes publisher install scripts. */
export class PluginManagerService {
  private candidates = new Map<
    string,
    { candidate: Candidate; expires: number }
  >();
  private controllers = new Map<string, AbortController>();
  private operations = new Map<
    string,
    { id: string; phase: string; detail?: string; cancellable: boolean }
  >();
  private states = new Map<
    string,
    { phase: string; error?: string; logs: string[] }
  >();
  private listeners = new Set<
    (state: ReturnType<PluginManagerService["read"]>) => void
  >();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly packages: PackageManager,
    readonly host: PluginHost,
  ) {
    packages.listeners.add((id, phase, detail) => {
      const previous = this.states.get(id);
      this.states.set(id, {
        phase,
        error: phase === "failed" ? detail : undefined,
        logs: [
          ...(previous?.logs ?? []),
          `${phase}${detail ? ": " + detail : ""}`,
        ].slice(-40),
      });
      this.emit();
    });
    host.subscribe({
      plugins: () => this.emit(),
      tree: () => {},
      toast: () => {},
    });
  }
  subscribe(
    listener: (state: ReturnType<PluginManagerService["read"]>) => void,
  ) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    const state = this.read();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {}
    }
  }
  read() {
    const registry = this.packages.registry();
    return {
      plugins: Object.values(registry.plugins)
        .filter((p) => !p.removed)
        .map((p) => {
          const runtime = this.host.list().find((x) => x.manifest.id === p.id);
          return {
            ...p,
            ...this.states.get(p.id),
            phase: !p.enabled
              ? "disabled"
              : runtime?.state === "crashed"
                ? "failed"
                : (this.states.get(p.id)?.phase ??
                  (!p.enabled
                    ? "disabled"
                    : runtime?.state === "running"
                      ? "ready"
                      : "starting")),
            error: this.states.get(p.id)?.error ?? runtime?.error,
            logs: [
              ...(this.states.get(p.id)?.logs ?? []),
              ...(runtime?.error
                ? [
                    `Runtime failure ${p.id} (${p.repo}): ${runtime.error.slice(0, 16000)}`,
                  ]
                : []),
            ].slice(-40),
            cleanup: !!p.manifest.cli?.cleanupScreen,
            availableVersion: this.available.get(p.id) ?? p.availableVersion,
            recovery: (p.history ?? []).map((h) => ({
              id: recoveryChoiceId(h),
              version: h.installed.version,
              schemaCompatible: (
                h.installed.manifest.data.supports ?? [
                  h.installed.manifest.data.schema,
                ]
              ).includes(p.dataSchema ?? p.manifest.data.schema),
              snapshotAt: existsSync(h.snapshot) ? h.at : undefined,
            })),
          };
        }),
      operations: [
        ...this.operations.values(),
        ...this.packages.recoveryWarnings
          .slice(-10)
          .map((detail, index) => ({
            id: `recovery-${index}`,
            phase: "failed",
            detail,
            cancellable: false,
          })),
      ],
      schedule: { intervalHours: 6, ...registry.updateSchedule },
    };
  }
  start() {
    this.expireApprovals();
    if (
      !this.packages.registry().updateSchedule?.nextCheck ||
      Date.now() >= (this.packages.registry().updateSchedule?.nextCheck ?? 0)
    )
      void this.checkUpdates();
    this.timer = setInterval(
      () => {
        this.expireApprovals();
        const schedule = this.packages.registry().updateSchedule;
        if (!schedule?.nextCheck || Date.now() >= schedule.nextCheck)
          void this.checkUpdates();
      },
      15 * 60 * 1000,
    );
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    for (const record of this.candidates.values())
      this.packages.releaseCandidate(record.candidate);
    this.candidates.clear();
  }
  private expireApprovals() {
    for (const [token, record] of this.candidates)
      if (record.expires < Date.now()) {
        this.packages.releaseCandidate(record.candidate);
        this.candidates.delete(token);
      }
    this.packages.collectCandidates();
  }
  private async resolve(request: ManagerRequest) {
    this.expireApprovals();
    const operationId = crypto.randomUUID(),
      controller = new AbortController();
    this.controllers.set(operationId, controller);
    this.operations.set(operationId, {
      id: operationId,
      phase: "downloading",
      detail: request.repo,
      cancellable: true,
    });
    this.emit();
    try {
      const candidate = await resolveGithub(this.packages, request.repo ?? "", {
        release: request.release,
        prerelease: request.prerelease,
        signal: controller.signal,
        onPhase: (phase) => {
          this.operations.set(operationId, {
            id: operationId,
            phase,
            detail: request.repo,
            cancellable: phase === "downloading",
          });
          this.emit();
        },
      });
      const token = crypto.randomUUID();
      this.candidates.set(token, {
        candidate,
        expires: Date.now() + 10 * 60 * 1000,
      });
      return {
        token,
        id: candidate.manifest.id,
        name: candidate.manifest.name,
        version: candidate.manifest.version,
        repo: candidate.repo,
        hash: candidate.hash,
        channel: candidate.channel ?? "stable",
        compatibility: {
          compatible: true,
          summary:
            "Host, Bun, platform and required capabilities are compatible",
        },
      };
    } finally {
      this.controllers.delete(operationId);
      this.operations.delete(operationId);
      this.emit();
    }
  }
  private checking = false;
  async checkUpdates() {
    if (this.checking) return;
    this.checking = true;
    try {
      let error: string | undefined;
      const updates = new Map<string, string | undefined>();
      for (const p of Object.values(this.packages.registry().plugins).filter(
        (p) => !p.removed,
      )) {
        try {
          const candidate = await resolveGithub(this.packages, p.repo, {
            prerelease: p.channel === "prerelease",
          });
          if (Bun.semver.order(candidate.manifest.version, p.version) > 0) {
            this.states.set(p.id, {
              phase: p.enabled ? "ready" : "disabled",
              logs: [`Update available: ${candidate.manifest.version}`],
            });
            this.available.set(p.id, candidate.manifest.version);
            updates.set(p.id, candidate.manifest.version);
          } else {
            this.available.delete(p.id);
            updates.set(p.id, undefined);
          }
          this.packages.releaseCandidate(candidate);
        } catch (e) {
          const detail = `${p.id} (${p.repo}): ${String(e)}`;
          error = error ? `${error}\n${detail}` : detail;
          const previous = this.states.get(p.id);
          this.states.set(p.id, {
            phase: p.enabled ? "ready" : "disabled",
            logs: [
              ...(previous?.logs ?? []),
              `Update check failed: ${detail}`,
            ].slice(-40),
          });
        }
      }
      const registry = this.packages.registry();
      for (const [id, version] of updates) {
        if (registry.plugins[id])
          registry.plugins[id]!.availableVersion = version;
      }
      registry.updateSchedule = {
        lastChecked: Date.now(),
        nextCheck: Date.now() + 6 * 3600000,
        error,
      };
      atomicJSON(join(this.packages.root, "plugins/registry.json"), registry);
      this.emit();
    } finally {
      this.checking = false;
    }
  }
  private available = new Map<string, string>();
  async handle(request: ManagerRequest) {
    try {
      switch (request.operation) {
        case "discard": {
          const record = this.candidates.get(request.token ?? "");
          if (record) {
            this.packages.releaseCandidate(record.candidate);
            this.candidates.delete(request.token!);
            this.packages.collectCandidates();
          }
          break;
        }
        case "resolve":
          return { candidate: await this.resolve(request) };
        case "install": {
          const record = this.candidates.get(request.token ?? "");
          if (!record || record.expires < Date.now())
            throw new Error(
              "Resolve release before execution approval (approval expired)",
            );
          await this.packages.install(record.candidate, true);
          this.candidates.delete(request.token!);
          break;
        }
        case "enable":
          await this.packages.enabled(request.id!, !!request.enabled);
          this.states.delete(request.id!);
          break;
        case "remove":
          await this.packages.remove(request.id!, !!request.deleteData);
          this.states.delete(request.id!);
          break;
        case "cancel": {
          const controller = this.controllers.get(request.operationId!);
          if (!controller)
            throw new Error(
              "Operation is no longer at a safe cancellation boundary",
            );
          controller.abort();
          break;
        }
        case "checkUpdates":
          await this.checkUpdates();
          break;
        case "setChannel": {
          if (!["stable", "prerelease"].includes(request.channel ?? ""))
            throw new Error("Invalid channel");
          const registry = this.packages.registry(),
            p = registry.plugins[request.id!];
          if (!p) throw new Error("Plugin missing");
          p.channel = request.channel!;
          delete p.availableVersion;
          this.available.delete(p.id);
          atomicJSON(
            join(this.packages.root, "plugins/registry.json"),
            registry,
          );
          break;
        }
        case "cleanup": {
          const p = this.packages.registry().plugins[request.id!];
          const screen = p?.manifest.cli?.cleanupScreen;
          if (!p || !screen)
            throw new Error("No plugin cleanup screen declared");
          if (!p.enabled) await this.packages.enabled(p.id, true);
          return { state: this.read(), navigate: { plugin: p.id, screen } };
        }
        case "recover":
          await this.packages.restore(request.id!, request.choiceId!);
          break;
        case "list":
        case "read":
          break;
        default:
          throw new Error("Unknown plugin operation");
      }
      this.emit();
      return {
        state: this.read(),
        installed: Object.values(this.packages.registry().plugins).filter(
          (p) => !p.removed,
        ),
      };
    } catch (error) {
      return {
        error: `${request.id ?? request.repo ?? request.operation}: ${String(error)}`,
        state: this.read(),
      };
    }
  }
}
