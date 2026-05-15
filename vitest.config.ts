import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "iquantum-daemon/**/*.test.ts",
      "iquantum-cli/**/*.test.ts",
    ],
  },
});
