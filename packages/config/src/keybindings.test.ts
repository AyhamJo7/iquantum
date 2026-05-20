import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadKeybindings } from "./keybindings";

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `iq-keybindings-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadKeybindings", () => {
  it("loads valid actions from JSON", async () => {
    const file = join(dir, "keybindings.json");
    await writeFile(file, JSON.stringify({ "ctrl+e": "export" }), "utf8");

    expect(loadKeybindings(file)).toEqual({ "ctrl+e": "export" });
  });

  it("skips invalid action values", async () => {
    const file = join(dir, "keybindings.json");
    await writeFile(file, JSON.stringify({ "ctrl+x": "nope" }), "utf8");

    expect(loadKeybindings(file)).toEqual({});
  });

  it("returns an empty map when the file is missing", () => {
    expect(loadKeybindings(join(dir, "missing.json"))).toEqual({});
  });
});
