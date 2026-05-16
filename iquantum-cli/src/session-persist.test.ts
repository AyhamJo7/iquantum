import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLastSession, writeLastSession } from "./session-persist";

describe("session persistence", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "iq-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when no last-session file exists", async () => {
    expect(await readLastSession(dir)).toBeNull();
  });

  it("round-trips a session ID through write and read", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    await writeLastSession(dir, id);
    expect(await readLastSession(dir)).toBe(id);
  });

  it("returns null for an empty file", async () => {
    await writeLastSession(dir, "");
    expect(await readLastSession(dir)).toBeNull();
  });

  it("overwrites an existing session ID", async () => {
    await writeLastSession(dir, "id-1");
    await writeLastSession(dir, "id-2");
    expect(await readLastSession(dir)).toBe("id-2");
  });

  it("creates the directory if it does not exist", async () => {
    const nested = join(dir, "nested", "deep");
    await writeLastSession(nested, "session-xyz");
    expect(await readLastSession(nested)).toBe("session-xyz");
  });
});
