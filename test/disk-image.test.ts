import { expect, test } from "bun:test";
import { retryDiskImage } from "../scripts/disk-image";

test("transient contention retries with bounded exponential delays and succeeds", async () => {
  const delays: number[] = [];
  let calls = 0;
  await retryDiskImage("create", async () => ({ exitCode: ++calls < 3 ? 1 : 0, stderr: "Resource busy" }), async ms => { delays.push(ms); });
  expect(calls).toBe(3);
  expect(delays).toEqual([1000, 2000]);
});

test("persistent contention stops after five attempts with diagnostics", async () => {
  let calls = 0;
  const delays: number[] = [];
  await expect(retryDiskImage("attach", async () => { calls++; return { exitCode: 1, stderr: "Resource temporarily unavailable" }; }, async ms => { delays.push(ms); })).rejects.toThrow("attach failed (attempt 5/5): Resource temporarily unavailable");
  expect(calls).toBe(5);
  expect(delays).toEqual([1000, 2000, 4000, 8000]);
});

test("permanent failures stop immediately without sleeping", async () => {
  await expect(retryDiskImage("create", async () => ({ exitCode: 1, stderr: "Invalid argument" }), async () => { throw Error("unexpected retry"); })).rejects.toThrow("create failed (attempt 1/5): Invalid argument");
});
