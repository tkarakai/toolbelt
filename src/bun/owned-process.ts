/** Only call for processes spawned detached by Toolbelt; observed/user jobs use different groups. */
export async function terminateOwned(
  proc: ReturnType<typeof Bun.spawn>,
  graceMs = 2000,
) {
  const signal = (name: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-proc.pid, name);
    } catch {
      try {
        proc.kill(name);
      } catch {}
    }
  };
  const alive = () => {
    try {
      process.kill(-proc.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  signal("SIGTERM");
  const gracefulDeadline = Date.now() + graceMs;
  // A parent exiting does not prove its owned descendants stopped.
  while (alive() && Date.now() < gracefulDeadline) await Bun.sleep(20);
  if (alive()) signal("SIGKILL");
  const hardDeadline = Date.now() + 1000;
  while (alive() && Date.now() < hardDeadline) await Bun.sleep(20);
  if (alive())
    throw new Error("Owned process group did not exit after SIGKILL");
  await proc.exited;
}
