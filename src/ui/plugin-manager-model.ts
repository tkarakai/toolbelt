import type { Installed } from "../bun/packages";
export type Phase =
  | "not installed"
  | "downloading"
  | "verifying"
  | "installed"
  | "disabled"
  | "starting"
  | "migrating"
  | "ready"
  | "stopping"
  | "updating"
  | "failed"
  | "quarantined"
  | "removing";
export type RecoveryChoice = {
  id: string;
  version: string;
  schemaCompatible: boolean;
  snapshotAt?: number;
};
export type ManagedPlugin = Installed & {
  phase?: Phase;
  error?: string;
  logs?: string[];
  detail?: string;
  operation?: {
    id: string;
    cancellable: boolean;
    received?: number;
    total?: number;
  };
  cleanup?: boolean;
  recovery?: RecoveryChoice[];
  availableVersion?: string;
};
export type Candidate = {
  token: string;
  id: string;
  name: string;
  version: string;
  repo: string;
  hash: string;
  channel?: "stable" | "prerelease";
  compatibility?: { compatible: boolean; summary: string };
  notes?: string;
};
export type ManagerState = {
  plugins: ManagedPlugin[];
  schedule?: {
    intervalHours: number;
    lastChecked?: number;
    nextCheck?: number;
    error?: string;
  };
  operations?: {
    id: string;
    phase: Phase;
    detail?: string;
    cancellable: boolean;
  }[];
};
/** Host supplies persisted state; subscribe must publish after every lifecycle transition. */
export interface PluginManagerAdapter {
  read(): Promise<ManagerState>;
  subscribe?(listener: (state: ManagerState) => void): () => void;
  resolve(input: {
    repo: string;
    release?: string;
    prerelease: boolean;
  }): Promise<Candidate>;
  install(token: string): Promise<void>;
  enable(id: string, enabled: boolean): Promise<void>;
  remove(id: string, deleteData: boolean): Promise<void>;
  cancel?(operationId: string): Promise<void>;
  discard?(token: string): Promise<void>;
  restart?(id: string): Promise<void>;
  checkUpdates?(): Promise<void>;
  setChannel?(id: string, channel: "stable" | "prerelease"): Promise<void>;
  cleanup?(id: string): Promise<void>;
  recover?(id: string, choiceId: string): Promise<void>;
}
export function canRecover(choice: RecoveryChoice) {
  return choice.schemaCompatible || choice.snapshotAt !== undefined;
}
export function canInstall(candidate: Candidate) {
  return candidate.compatibility?.compatible === true;
}
export function isActivePhase(phase?: Phase) {
  return (
    !!phase &&
    [
      "downloading",
      "verifying",
      "starting",
      "migrating",
      "stopping",
      "updating",
      "removing",
    ].includes(phase)
  );
}
let registered: PluginManagerAdapter | undefined;
export function registerPluginManagerAdapter(adapter: PluginManagerAdapter) {
  registered = adapter;
}
export function getPluginManagerAdapter() {
  return registered;
}
