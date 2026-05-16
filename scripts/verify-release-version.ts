#!/usr/bin/env bun
import { join } from "node:path";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (!tag) {
  console.error("usage: bun scripts/verify-release-version.ts <tag>");
  process.exit(1);
}

const packageJson = (await Bun.file(
  join(import.meta.dir, "..", "iquantum-cli", "package.json"),
).json()) as { version: string };
const expectedTag = `v${packageJson.version}`;

if (tag !== expectedTag) {
  console.error(
    `release tag/version mismatch: tag is ${tag}, package version requires ${expectedTag}`,
  );
  process.exit(1);
}

console.log(`release version verified: ${tag}`);
