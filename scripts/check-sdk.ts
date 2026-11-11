// SDK runtime plus its bundled release CLI, archive and host-verification dependencies.
const tests = (await Bun.file("tsconfig.sdk.json").json()).include.filter(
  (path: string) => path.endsWith(".test.ts"),
) as string[];
for (const command of [
  [process.execPath, "run", "sdk:typecheck"],
  [process.execPath, "test", ...tests.map(path => `./${path}`)],
]) {
  const child = Bun.spawn(command, {stdin:"ignore",stdout:"inherit",stderr:"inherit"});
  const code = await child.exited;
  if (code) process.exit(code);
}
