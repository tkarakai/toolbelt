/** Compatibility facts about an installed plugin, shown in Settings → Plugins (see src/bun/plugin-inspection.ts). */
export type PluginInspection = {
  /** Every requirement below is met by this host. */
  compatible: boolean;
  protocol: { plugin: number; host: number; ok: boolean };
  host: { requires: string; version: string; ok: boolean };
  bun: { requires: string; version: string; ok: boolean };
  platforms: { declared: string[]; current: string; ok: boolean };
  capabilities: {
    required: { id: string; supported: boolean }[];
    optional: { id: string; supported: boolean }[];
  };
  /** `agent.access` as the plugin declares it; undefined when it doesn't declare one. */
  agentAccess?: "none" | "read" | "act";
  /** SDK version the running plugin reported when it started; undefined until it has started. */
  sdk?: string;
  data: { schema: number; supports?: number[] };
  screens: number;
  quickView: boolean;
  command?: string;
};
