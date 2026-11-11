import { useEffect, useState } from "react";
import App from "./App";
import Popover from "./Popover";
import { rpc, usePlugins } from "./lib/store";

export type TesterControl = (
  operation: string,
  params?: Record<string, unknown>,
) => Promise<any>;
/** A frame around the production surfaces, including their real settings and navigation. */
export default function Tester({ control }: { control: TesterControl }) {
  const plugins = usePlugins();
  const [popover, setPopover] = useState(false);
  const [width, setWidth] = useState(1000);
  const [reduced, setReduced] = useState(false);
  const [archive, setArchive] = useState("");
  const [repo, setRepo] = useState("");
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState<unknown[]>([]);
  const [watching, setWatching] = useState(false);
  const run = async (op: string, params = {}) => {
    try {
      setError("");
      return await control(op, params);
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    const timer = setInterval(() => {
      void control("diagnostics")
        .then(setDiagnostics)
        .catch((e) => setError(String(e)));
    }, 1000);
    return () => clearInterval(timer);
  }, [control]);
  return (
    <div className="h-screen flex flex-col bg-background text-foreground text-sm">
      <style>{`.tester-surface .h-svh{height:100%}.tester-surface .min-h-svh{min-height:0}.tester-surface>[data-slot="sidebar-wrapper"]{flex:1;min-height:0}`}</style>
      {reduced && (
        <style>{`*,*::before,*::after {animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}`}</style>
      )}
      <header className="p-3 border-b space-y-2">
        <strong>ToolBelt Plugin Tester · isolated profile</strong>
        {watching && (
          <b className="text-destructive ml-4">
            DEV WATCH · automatic execution approved
          </b>
        )}
        <div className="flex flex-wrap gap-2 items-center">
          <input
            aria-label="Built archive path"
            className="border rounded p-1"
            placeholder="/path/plugin.tar.gz"
            value={archive}
            onChange={(e) => setArchive(e.target.value)}
          />
          <input
            aria-label="Publisher repository"
            className="border rounded p-1"
            placeholder="owner/repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />{" "}
            Execute this publisher’s plugin code as my user
          </label>
          <button
            disabled={!approved}
            onClick={() => void run("load", { archive, repo, approved })}
          >
            Open archive
          </button>
          <button
            disabled={!approved}
            onClick={() =>
              void run("watch", { archive, repo, approved }).then(
                (result) => result && setWatching(true),
              )
            }
          >
            Watch built archive
          </button>
          <button
            onClick={() => void run("unwatch").then(() => setWatching(false))}
          >
            Stop watch
          </button>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <button onClick={() => setPopover(!popover)}>
            {popover ? "Main window" : "Simulated popover"}
          </button>
          <label>
            Width{" "}
            <input
              aria-label="Viewport width"
              type="range"
              min="320"
              max="1600"
              value={width}
              onChange={(e) => {
                setWidth(+e.target.value);
                void run("viewport", { width: +e.target.value });
              }}
            />{" "}
            {width}px
          </label>
          <label>
            <input
              type="checkbox"
              checked={reduced}
              onChange={(e) => setReduced(e.target.checked)}
            />{" "}
            Reduced motion
          </label>
          <button onClick={() => void run("nativePopover")}>
            Opt in to native menu bar
          </button>
          <span>Appearance and zoom: production Settings / ⌘+ / ⌘−</span>
          {plugins.map((p) => (
            <span key={p.manifest.id}>
              {p.manifest.name}: {p.state}{" "}
              <button
                onClick={() =>
                  void rpc.request.restartPlugin({ plugin: p.manifest.id })
                }
              >
                Restart
              </button>{" "}
              <button
                onClick={() => {
                  if (
                    confirm(
                      `Delete tester data for ${p.manifest.name}? Reopen archive to initialize.`,
                    )
                  )
                    void run("reset", { id: p.manifest.id });
                }}
              >
                Reset data
              </button>
            </span>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </header>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div
          style={{
            width: popover ? 768 : width,
            maxWidth: "100%",
            margin: "0 auto",
          }}
          className="tester-surface flex flex-col min-h-0 relative isolate transform-gpu overflow-hidden border-x transition-[width] duration-200"
        >
          {popover ? <Popover /> : <App />}
        </div>
      </div>
      <details className="border-t p-2 max-h-64 overflow-auto">
        <summary>
          Validated protocol / lifecycle diagnostics ({diagnostics.length})
        </summary>
        <pre className="whitespace-pre-wrap break-all">
          {JSON.stringify(diagnostics, null, 2)}
        </pre>
      </details>
    </div>
  );
}
