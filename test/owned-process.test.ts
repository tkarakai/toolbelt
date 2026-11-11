import { test, expect } from "bun:test";
import { terminateOwned } from "../src/bun/owned-process";
test("owned descendants ignoring TERM are killed even when parent exits first", async () => {
  const code = `const child=Bun.spawn([process.execPath,'-e','process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'],{stdout:'pipe',stderr:'ignore'});await child.stdout.getReader().read();console.log(child.pid);setInterval(()=>{},1000)`;
  const proc = Bun.spawn([process.execPath, "-e", code], {
    detached: true,
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = proc.stdout.getReader();
  try {
    const chunk = await reader.read();
    const child = Number(new TextDecoder().decode(chunk.value).trim());
    expect(child).toBeGreaterThan(0);
    await terminateOwned(proc, 40);
    expect(() => process.kill(-proc.pid, 0)).toThrow();
    // macOS may report the killed orphan PID briefly while init reaps it.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(child, 0); } catch { break; }
      await Bun.sleep(20);
    }
    expect(() => process.kill(child, 0)).toThrow();
  } finally {
    reader.releaseLock();
    try { process.kill(-proc.pid, "SIGKILL"); } catch {}
    await proc.exited;
  }
});
