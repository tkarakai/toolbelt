import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SDK_VERSION } from "../src/shared/package";
import { run } from "../src/release/core";
test("installed SDK archive supplies runtime, typed release API and executable without a host checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "toolbelt-sdk-install-"));
  try {
    await run(
      [process.execPath, "scripts/build-sdk.ts"],
      join(import.meta.dir, ".."),
      { ...process.env, TOOLBELT_SDK_OUTPUT: join(root, "output") },
    );
    const archive = join(root, "output", `toolbelt-sdk-${SDK_VERSION}.tgz`);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        type: "module",
        dependencies: { "@toolbelt/sdk": "file:" + archive },
      }),
    );
    await run([process.execPath, "install"], root);
    await run([process.execPath, "install", "--frozen-lockfile"], root);
    writeFileSync(
      join(root, "check.ts"),
      `import {definePlugin} from '@toolbelt/sdk';import {packagePlugin,verifyPlugin} from '@toolbelt/sdk/release';if(typeof definePlugin!=='function'||typeof packagePlugin!=='function'||typeof verifyPlugin!=='function')throw Error('Missing exports');`,
    );
    await run([process.execPath, "check.ts"], root);
    const help = await run(
      [process.execPath, "run", "--bun", "toolbelt-release", "--help"],
      root,
    );
    expect(help).toContain(
      "Merging the validated release PR authorizes CI publication",
    );
    writeFileSync(
      join(root, "plugin.ts"),
      `import {definePlugin} from '@toolbelt/sdk';definePlugin({render:{'screen:main':()=>({type:'text',text:'fixture'})}});`,
    );
    const built = await Bun.build({
      entrypoints: [join(root, "plugin.ts")],
      target: "bun",
    });
    expect(built.success).toBe(true);
    const text = await built.outputs[0]!.text();
    expect(text).not.toContain("ci-publish");
    expect(text).not.toContain("Frozen bytes changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
