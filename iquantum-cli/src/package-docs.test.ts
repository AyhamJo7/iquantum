import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyPackageDocs, PACKAGE_DOC_FILES } from "../../scripts/package-docs";

const repoRoot = resolve(__dirname, "../..");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iquantum-package-docs-"));
  tempDirs.push(dir);
  return dir;
}

describe("copyPackageDocs", () => {
  it("copies the README, LICENSE and NOTICE into the package directory", async () => {
    const root = await makeTempDir();
    const pkg = await makeTempDir();
    for (const file of PACKAGE_DOC_FILES) {
      await writeFile(join(root, file), `content of ${file}`);
    }

    await copyPackageDocs(root, pkg);

    expect((await readdir(pkg)).sort()).toEqual([...PACKAGE_DOC_FILES].sort());
    expect(await readFile(join(pkg, "LICENSE"), "utf8")).toBe(
      "content of LICENSE",
    );
  });

  it("fails loudly when a document is missing instead of publishing without it", async () => {
    const root = await makeTempDir();
    const pkg = await makeTempDir();
    await writeFile(join(root, "README.md"), "readme");

    await expect(copyPackageDocs(root, pkg)).rejects.toThrow();
  });
});

describe("published package metadata", () => {
  it("declares license, repository and homepage so the npm page links back here", async () => {
    const manifest = JSON.parse(
      await readFile(join(repoRoot, "iquantum-cli/package.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.description).toEqual(expect.any(String));
    expect(manifest.homepage).toEqual(expect.stringContaining("github.com"));
    expect(manifest.repository).toMatchObject({
      type: "git",
      directory: "iquantum-cli",
    });
    expect(manifest.files).toContain("NOTICE");
  });

  it.each([
    "LICENSE",
    "iquantum-vscode/LICENSE",
  ])("keeps %s as the unmodified Apache-2.0 text so GitHub and npm can detect it", async (path) => {
    const text = (await readFile(join(repoRoot, path), "utf8")).replace(
      /\s+/g,
      " ",
    );

    expect(text).toContain("Apache License Version 2.0, January 2004");
    expect(text).toContain(
      "You may act only on Your own behalf and on Your sole responsibility",
    );
    expect(text).toContain("APPENDIX: How to apply the Apache License");
  });
});
