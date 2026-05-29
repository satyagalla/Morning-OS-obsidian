import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";

const prod = process.argv[2] === "production";
const watch = process.argv[2] === "watch";
const deploy = process.argv[2] === "deploy";

const PLUGIN_DIR = process.env.OBSIDIAN_PLUGIN_DIR ?? "D:/Productivity/OS/.obsidian/plugins/morning-os";

const builtins = [
  "assert", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "dns", "domain", "events", "fs", "http", "https",
  "module", "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "stream", "string_decoder", "sys",
  "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
];

function copyToVault() {
  if (!PLUGIN_DIR) return;
  const files = [
    ["main.js", "main.js"],
    ["manifest.json", "manifest.json"],
    ["styles/styles.css", "styles.css"],
  ];
  for (const [src, dest] of files) {
    const srcPath = path.resolve(src);
    const destPath = path.join(PLUGIN_DIR, dest);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  console.log(`[deploy] copied to ${PLUGIN_DIR}`);
}

const copyPlugin = {
  name: "copy-to-vault",
  setup(build) {
    build.onEnd(() => { if (watch || deploy) copyToVault(); });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: (prod || deploy) ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod || deploy,
  plugins: [copyPlugin],
});

if (watch) {
  await ctx.watch();
  console.log("[watch] watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}

