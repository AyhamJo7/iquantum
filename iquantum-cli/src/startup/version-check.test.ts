import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, isNewerVersion } from "./version-check";

describe("isNewerVersion", () => {
  it("detects a newer patch version", () => {
    expect(isNewerVersion("1.0.0", "1.0.1")).toBe(true);
  });
  it("detects a newer minor version", () => {
    expect(isNewerVersion("1.0.0", "1.1.0")).toBe(true);
  });
  it("detects a newer major version", () => {
    expect(isNewerVersion("1.0.0", "2.0.0")).toBe(true);
  });
  it("returns false for equal versions", () => {
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
  });
  it("returns false when current is newer", () => {
    expect(isNewerVersion("1.2.0", "1.1.9")).toBe(false);
  });
  it("handles v-prefixed strings", () => {
    expect(isNewerVersion("v1.0.0", "v1.0.1")).toBe(true);
  });
});

describe("checkForUpdate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `iq-vc-test-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tmpDir, { recursive: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ version: "9.9.9" }),
      }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("returns no update when cache is absent (fires background fetch)", () => {
    const status = checkForUpdate("1.0.0", tmpDir);
    expect(status).toEqual({ updateAvailable: false, latestVersion: null });
  });

  it("returns no update when cached version equals current", async () => {
    await writeFile(
      join(tmpDir, "update-check.json"),
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        latestVersion: "1.0.0",
      }),
    );
    const status = checkForUpdate("1.0.0", tmpDir);
    expect(status).toEqual({ updateAvailable: false, latestVersion: "1.0.0" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns updateAvailable when cached version is newer", async () => {
    await writeFile(
      join(tmpDir, "update-check.json"),
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        latestVersion: "1.0.1",
      }),
    );
    const status = checkForUpdate("1.0.0", tmpDir);
    expect(status).toEqual({ updateAvailable: true, latestVersion: "1.0.1" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fires a background fetch when cache is stale (>24h)", async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeFile(
      join(tmpDir, "update-check.json"),
      JSON.stringify({ checkedAt: staleDate, latestVersion: "1.0.0" }),
    );
    checkForUpdate("1.0.0", tmpDir);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not fire fetch when cache is fresh", async () => {
    await writeFile(
      join(tmpDir, "update-check.json"),
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        latestVersion: "1.0.0",
      }),
    );
    checkForUpdate("1.0.0", tmpDir);
    expect(fetch).not.toHaveBeenCalled();
  });
});
