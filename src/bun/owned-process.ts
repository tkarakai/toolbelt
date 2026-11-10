/** Only call for a process spawned detached by Toolbelt; observed/user terminal jobs use different groups. */
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
  signal("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      proc.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          signal("SIGKILL");
          resolve();
        }, graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      proc.exited,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Owned process did not exit after SIGKILL")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
