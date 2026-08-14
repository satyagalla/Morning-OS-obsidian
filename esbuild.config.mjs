import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";

// Load proxy env vars if present (never committed). Minimal stand-in for
// dotenv: only used at build time to inject FEEDBACK_PROXY_URL/SECRET below.
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.resolve("proxy/.env"));

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
  define: {
    "__FEEDBACK_PROXY_URL__": JSON.stringify(process.env.FEEDBACK_PROXY_URL ?? ""),
    "__FEEDBACK_SECRET__":    JSON.stringify(process.env.FEEDBACK_SECRET ?? ""),
  },
  loader: { ".md": "text" },
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

