// Plugin development mode, as seen by the renderer and the debug channel
// (docs/plugin-development.md).

export type DevelopmentDiagnostic = { time: string; kind: string; detail: unknown };

export type DevelopmentState = {
  /** False where mode switching isn't offered (hosts without development mode). */
  available: boolean;
  /** This process runs a development profile. */
  active: boolean;
  profile: string | null;
  /** Existing development profiles, by name. */
  profiles: string[];
  /** Local plugins still installed in this profile, the archive each came from and its watch. */
  sources: { id: string; archive: string; repo: string; watching: boolean }[];
  /** A mode switch is preparing plugins; the app relaunches when it succeeds. */
  switching: boolean;
};

export type DevelopmentRequest = {
  operation:
    | "state"
    | "choose"
    | "enter"
    | "exit"
    | "load"
    | "watch"
    | "reset"
    | "diagnostics";
  profile?: string;
  archive?: string;
  repo?: string;
  approved?: boolean;
  /** `load`: also watch the archive. `watch`: turn the plugin's watch on or off. */
  watch?: boolean;
  watching?: boolean;
  id?: string;
};

export type DevelopmentResponse = {
  state: DevelopmentState;
  diagnostics?: DevelopmentDiagnostic[];
  /** `load`, and `reset` when the recorded archive was reinstalled. */
  installed?: { id: string; version: string; hash: string };
  /** From `choose`: the selected archive (absent when cancelled) and its manifest's publisher. */
  chosen?: { archive: string; repo: string | null };
  error?: string;
};

export const UNAVAILABLE_DEVELOPMENT: DevelopmentState = {
  available: false,
  active: false,
  profile: null,
  profiles: [],
  sources: [],
  switching: false,
};
