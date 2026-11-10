import { test, expect } from "bun:test";
import { terminateOwned } from "../src/bun/owned-process";
test("owned descendants ignoring TERM are killed even when parent exits first", async () => {
  const code = `const child=Bun.spawn([process.execPath,'-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore'});console.log(child.pid);setInterval(()=>{},1000)`;
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
    await Bun.sleep(100);
    await terminateOwned(proc, 40);
    expect(() => process.kill(-proc.pid, 0)).toThrow();
    expect(() => process.kill(child, 0)).toThrow();
  } finally {
    reader.releaseLock();
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
  }
});
