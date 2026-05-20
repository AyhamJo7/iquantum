import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillLoader } from "./loader";

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `iq-skills-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SkillLoader", () => {
  it("loads a valid skill module", async () => {
    await writeFile(
      join(dir, "standup.js"),
      'export default { name: "standup", description: "daily", async run() {} };',
      "utf8",
    );

    const skills = await SkillLoader.load(dir);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "standup", description: "daily" });
  });

  it("skips a module with a missing name", async () => {
    await writeFile(
      join(dir, "bad.js"),
      'export default { description: "bad", async run() {} };',
      "utf8",
    );

    expect(await SkillLoader.load(dir)).toEqual([]);
  });

  it("returns an empty array when the directory does not exist", async () => {
    expect(await SkillLoader.load(join(dir, "missing"))).toEqual([]);
  });
});
