import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@iquantum/config": resolve(__dirname, "packages/config/src/index.ts"),
      "@iquantum/context-window": resolve(
        __dirname,
        "packages/context-window/src/index.ts",
      ),
      "@iquantum/diff-engine": resolve(
        __dirname,
        "packages/diff-engine/src/index.ts",
      ),
      "@iquantum/git": resolve(__dirname, "packages/git/src/index.ts"),
      "@iquantum/llm": resolve(__dirname, "packages/llm/src/index.ts"),
      "@iquantum/piv-engine": resolve(
        __dirname,
        "packages/piv-engine/src/index.ts",
      ),
      "@iquantum/protocol": resolve(
        __dirname,
        "packages/protocol/src/index.ts",
      ),
      "@iquantum/repo-map": resolve(
        __dirname,
        "packages/repo-map/src/index.ts",
      ),
      "@iquantum/sandbox": resolve(__dirname, "packages/sandbox/src/index.ts"),
      "@iquantum/types": resolve(__dirname, "packages/types/src/index.ts"),
    },
  },
  test: {
    pool: "vmForks",
    include: [
      "packages/**/*.test.ts",
      "iquantum-daemon/**/*.test.ts",
      "iquantum-cli/**/*.test.ts",
    ],
  },
});
