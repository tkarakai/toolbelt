/** Retry only transient DiskImages contention, keeping permanent failures immediate. */
export async function retryDiskImage(
  label: string,
  operation: () => Promise<{ exitCode: number; stderr: Buffer | string }>,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await operation();
    if (result.exitCode === 0) return;
    const detail = result.stderr.toString().trim();
    if (attempt === 5 || !/Resource temporarily unavailable|Resource busy/i.test(detail))
      throw new Error(`${label} failed (attempt ${attempt}/5): ${detail}`);
    const delay = 1000 * 2 ** (attempt - 1);
    console.warn(`${label}: disk image temporarily busy; retrying in ${delay / 1000}s (attempt ${attempt}/5)`);
    await sleep(delay);
  }
}
