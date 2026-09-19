import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "morning-os-tests-"));
const entries = ["tests/state-store.test.ts", "tests/ui.test.ts", "tests/widgets.test.ts", "tests/calendar.test.ts", "tests/calendar-auth.test.ts", "tests/calendar-secret-store.test.ts"];
const obsidianStub = fileURLToPath(new URL("../tests/obsidian-test-stub.ts", import.meta.url));

try {
  const outputs = [];
  for (const entry of entries) {
    const output = join(directory, `${entry.split("/").at(-1)?.replace(".ts", ".cjs")}`);
    outputs.push(output);
    await build({
      entryPoints: [entry],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node20",
      outfile: output,
      loader: { ".md": "text" },
      define: {
        "__FEEDBACK_PROXY_URL__": '""',
        "__FEEDBACK_SECRET__": '""',
      },
      plugins: [{
        name: "test-obsidian-stub",
        setup(buildContext) {
          buildContext.onResolve({ filter: /^obsidian$/ }, () => ({ path: obsidianStub }));
        },
      }],
    });
  }
  const exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, ["--test", ...outputs], { stdio: "inherit" });
    child.on("close", code => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
  process.exitCode = exitCode;
} finally {
  await rm(directory, { recursive: true, force: true });
}
