import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface UpdateCache {
  checkedAt: string;
  latestVersion: string;
}

export interface UpdateStatus {
  updateAvailable: boolean;
  latestVersion: string | null;
}

/** Compares two semver strings. Returns true if `b` is strictly newer than `a`. */
export function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const [aMaj = 0, aMin = 0, aPat = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPat = 0] = parse(b);
  if (bMaj !== aMaj) return bMaj > aMaj;
  if (bMin !== aMin) return bMin > aMin;
  return bPat > aPat;
}

/**
 * Reads the update cache and returns the current update status synchronously.
 * If the cache is stale (>24 h), fires a background fetch to refresh it —
 * the result will be visible on the *next* startup. Never blocks startup.
 */
export function checkForUpdate(
  currentVersion: string,
  cacheDir: string,
  packageName = "@iquantum/cli",
): UpdateStatus {
  const cachePath = join(cacheDir, "update-check.json");
  let cached: UpdateCache | null = null;

  try {
    cached = JSON.parse(readFileSync(cachePath, "utf8")) as UpdateCache;
  } catch {
    // Cache absent or malformed — treat as stale.
  }

  const staleCutoff = 24 * 60 * 60 * 1000;
  const isStale =
    !cached || Date.now() - new Date(cached.checkedAt).getTime() > staleCutoff;

  if (isStale) {
    // Fire and forget — never awaited.
    void fetch(`https://registry.npmjs.org/${packageName}/latest`)
      .then((res) => res.json())
      .then((data: unknown) => {
        const latest =
          typeof data === "object" &&
          data !== null &&
          "version" in data &&
          typeof (data as { version: unknown }).version === "string"
            ? (data as { version: string }).version
            : null;
        if (!latest) return;
        try {
          mkdirSync(cacheDir, { recursive: true });
          writeFileSync(
            cachePath,
            JSON.stringify(
              { checkedAt: new Date().toISOString(), latestVersion: latest },
              null,
              2,
            ),
            "utf8",
          );
        } catch {
          // Best-effort write; ignore errors.
        }
      })
      .catch(() => {
        // Network errors are silently ignored — never surface to the user.
      });
  }

  if (!cached?.latestVersion) {
    return { updateAvailable: false, latestVersion: null };
  }

  return {
    updateAvailable: isNewerVersion(currentVersion, cached.latestVersion),
    latestVersion: cached.latestVersion,
  };
}
