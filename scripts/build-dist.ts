#!/usr/bin/env bun
/**
 * Production bundle script. Run via `bun run build:dist`.
 *
 * 1. Reads the version from iquantum-cli/package.json
 * 2. Writes iquantum-cli/src/version.ts with the real version
 * 3. Bundles daemon → iquantum-cli/dist/daemon.js
 * 4. Bundles CLI   → iquantum-cli/dist/bin.js
 * 5. Makes bin.js executable
 */

import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const cliDir = join(root, "iquantum-cli");
const distDir = join(cliDir, "dist");
const repoMapRequire = createRequire(
  join(root, "packages", "repo-map", "src", "index.ts"),
);

// 1. Read version
const cliPkg = (await Bun.file(join(cliDir, "package.json")).json()) as {
  version: string;
};
const version = cliPkg.version;
console.log(`Building iquantum v${version}…`);

// 2. Recreate dist dir. TypeScript also uses iquantum-cli/dist during local
// builds; a release bundle must not accidentally publish stale compiler output.
await rm(distDir, { force: true, recursive: true });
await mkdir(distDir, { recursive: true });

// 4. Bundle daemon
const daemonResult = await Bun.build({
  entrypoints: [join(root, "iquantum-daemon", "src", "index.ts")],
  outdir: distDir,
  naming: "daemon.js",
  target: "bun",
  minify: true,
  external: ["bun:sqlite", "bun:ffi"],
});
if (!daemonResult.success) {
  for (const log of daemonResult.logs) console.error(log);
  process.exit(1);
}
const daemonSize = ((daemonResult.outputs[0]?.size ?? 0) / 1024).toFixed(0);
console.log(`  built dist/daemon.js (${daemonSize} KB)`);

// 5. Copy tree-sitter grammar wasm assets. Source mode resolves these from
// node_modules; the self-contained daemon resolves the co-located copies.
const grammarAssets = [
  ["tree-sitter-go/tree-sitter-go.wasm", "tree-sitter-go.wasm"],
  ["tree-sitter-python/tree-sitter-python.wasm", "tree-sitter-python.wasm"],
  ["tree-sitter-rust/tree-sitter-rust.wasm", "tree-sitter-rust.wasm"],
  [
    "tree-sitter-typescript/tree-sitter-typescript.wasm",
    "tree-sitter-typescript.wasm",
  ],
  ["tree-sitter-typescript/tree-sitter-tsx.wasm", "tree-sitter-tsx.wasm"],
] as const;

for (const [source, fileName] of grammarAssets) {
  await copyFile(repoMapRequire.resolve(source), join(distDir, fileName));
}
console.log(`  copied ${grammarAssets.length} grammar wasm assets`);

// 6. Bundle CLI bin
const cliResult = await Bun.build({
  entrypoints: [join(cliDir, "src", "index.ts")],
  outdir: distDir,
  naming: "bin.js",
  target: "bun",
  minify: true,
  define: {
    "process.env.DEV": '"false"',
  },
});
if (!cliResult.success) {
  for (const log of cliResult.logs) console.error(log);
  process.exit(1);
}
const cliSize = ((cliResult.outputs[0]?.size ?? 0) / 1024).toFixed(0);
console.log(`  built dist/bin.js (${cliSize} KB)`);

// 7. Make bin executable
await chmod(join(distDir, "bin.js"), 0o755);

console.log(`Done. dist/ is ready for npm publish.`);
