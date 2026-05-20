import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookEvent, HookRun } from "@iquantum/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hook } from "./index";
import { HookLoader } from "./loader";
import { HookRunner } from "./runner";
import { ShellHook } from "./shell-hook";

const event: HookEvent = {
  type: "pre_apply_diff",
  file: "src/a.ts",
  patch: "diff",
  sessionId: "session-1",
};

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `iq-hooks-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("HookRunner", () => {
  it("returns blocked when a gate hook blocks", async () => {
    const store = new MemoryHookRunStore();
    const runner = new HookRunner(
      [hook("blocker", async () => ({ block: true, message: "denied" }))],
      store,
      () => "now",
    );

    await expect(runner.gate(event)).resolves.toEqual({
      allowed: false,
      message: "denied",
    });
    expect(store.runs[0]).toMatchObject({ hookName: "blocker", blocked: true });
  });

  it("lets gate pass when a hook throws", async () => {
    const runner = new HookRunner(
      [
        hook("bad", async () => {
          throw new Error("boom");
        }),
      ],
      new MemoryHookRunStore(),
      () => "now",
    );

    await expect(runner.gate(event)).resolves.toEqual({ allowed: true });
  });

  it("lets gate pass when a shell hook times out", async () => {
    const file = join(dir, "slow.sh");
    await writeFile(
      file,
      '#!/usr/bin/env bash\nsleep 1\nprintf \'{"block":true,"message":"late"}\'\n',
      "utf8",
    );
    await chmod(file, 0o755);
    const runner = new HookRunner(
      [new ShellHook("slow", file, ["pre_apply_diff"], 10)],
      new MemoryHookRunStore(),
      () => "now",
    );

    await expect(runner.gate(event)).resolves.toEqual({ allowed: true });
  });

  it("fires all matching hooks without throwing on errors", async () => {
    const calls: string[] = [];
    const runner = new HookRunner(
      [
        hook("one", async () => {
          calls.push("one");
          return {};
        }),
        hook("two", async () => {
          calls.push("two");
          throw new Error("boom");
        }),
      ],
      new MemoryHookRunStore(),
      () => "now",
    );

    await expect(runner.fire(event)).resolves.toBeUndefined();
    expect(calls.sort()).toEqual(["one", "two"]);
  });
});

describe("ShellHook", () => {
  it("writes event JSON to stdin and parses stdout", async () => {
    const file = join(dir, "test.sh");
    const capture = join(dir, "stdin.json");
    await writeFile(
      file,
      `#!/usr/bin/env bash\ncat > ${capture}\nprintf '{"block":false}'\n`,
      "utf8",
    );
    await chmod(file, 0o755);

    const result = await new ShellHook(
      "test",
      file,
      ["pre_apply_diff"],
      1000,
    ).run(event);

    expect(result).toEqual({ block: false });
    expect(JSON.parse(await readFile(capture, "utf8"))).toMatchObject({
      type: "pre_apply_diff",
      sessionId: "session-1",
    });
  });
});

describe("HookLoader", () => {
  it("loads shell hooks and skips invalid JS hooks", async () => {
    const shell = join(dir, "test.sh");
    await writeFile(shell, "# events: post_validate\n", "utf8");
    await chmod(shell, 0o755);
    await writeFile(join(dir, "bad.js"), "export default {}", "utf8");

    const hooks = await HookLoader.load(dir, 1000);

    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      name: "test",
      events: ["post_validate"],
    });
  });
});

class MemoryHookRunStore {
  readonly runs: HookRun[] = [];

  async insert(run: HookRun): Promise<void> {
    this.runs.push(run);
  }
}

function hook(name: string, run: Hook["run"]): Hook {
  return {
    name,
    filePath: `/tmp/${name}`,
    events: ["pre_apply_diff"],
    run,
  };
}
