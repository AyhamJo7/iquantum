import { describe, expect, it } from "vitest";
import type { LocalCommand } from "./registry";
import { CommandRegistry } from "./registry";

const makeCmd = (name: string): LocalCommand => ({
  name,
  description: `${name} description`,
  run() {},
});

describe("CommandRegistry", () => {
  it("getCompletions returns all commands matching the prefix", () => {
    const reg = new CommandRegistry([
      makeCmd("help"),
      makeCmd("clear"),
      makeCmd("compact"),
    ]);

    expect(reg.getCompletions("c").map((c) => c.name)).toEqual([
      "clear",
      "compact",
    ]);
    expect(reg.getCompletions("h").map((c) => c.name)).toEqual(["help"]);
    expect(reg.getCompletions("z")).toHaveLength(0);
  });

  it("getCompletions matches commands case-insensitively", () => {
    const reg = new CommandRegistry([makeCmd("help"), makeCmd("history")]);
    // Upper-case prefix should still match lower-case command names
    expect(reg.getCompletions("H").map((c) => c.name)).toEqual([
      "help",
      "history",
    ]);
  });

  it("get returns the command by exact name (case-insensitive)", () => {
    const reg = new CommandRegistry([makeCmd("quit")]);
    expect(reg.get("quit")?.name).toBe("quit");
    expect(reg.get("QUIT")?.name).toBe("quit");
    expect(reg.get("nope")).toBeUndefined();
  });

  it("getAll returns every registered command", () => {
    const cmds = [makeCmd("a"), makeCmd("b"), makeCmd("c")];
    expect(new CommandRegistry(cmds).getAll()).toHaveLength(3);
  });

  it("registerSkill exposes a skill as a command", () => {
    const reg = new CommandRegistry([makeCmd("help")]);
    reg.registerSkill({
      name: "standup",
      description: "daily notes",
      async run() {},
    });

    expect(reg.get("standup")).toMatchObject({
      name: "standup",
      description: "daily notes",
    });
    expect(reg.getSkillCommands().map((cmd) => cmd.name)).toEqual(["standup"]);
  });

  it("clearSkills removes skill commands but keeps built-ins", () => {
    const reg = new CommandRegistry([makeCmd("help")]);
    reg.registerSkill({
      name: "standup",
      description: "daily notes",
      async run() {},
    });

    reg.clearSkills();

    expect(reg.get("standup")).toBeUndefined();
    expect(reg.get("help")).toBeDefined();
  });
});
