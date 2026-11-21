import { copyFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Repository-level files that must ship inside the published npm tarball.
 * `npm publish` runs from `iquantum-cli/`, so without these copies the npm
 * page has no README and no license text.
 */
export const PACKAGE_DOC_FILES = ["README.md", "LICENSE", "NOTICE"] as const;

export async function copyPackageDocs(
  repoRoot: string,
  packageDir: string,
): Promise<void> {
  for (const file of PACKAGE_DOC_FILES) {
    await copyFile(join(repoRoot, file), join(packageDir, file));
  }
}
