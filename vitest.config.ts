import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "vmForks",
    include: [
      "packages/**/*.test.ts",
      "iquantum-daemon/**/*.test.ts",
      "iquantum-cli/**/*.test.ts",
    ],
  },
});
