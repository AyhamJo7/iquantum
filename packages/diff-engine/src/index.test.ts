import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ExecResult,
  isDockerAvailable,
  SandboxManager,
} from "@iquantum/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyFilePatch,
  DiffApplyError,
  DiffEngine,
  type FilePatch,
  parseUnifiedDiff,
} from "./index";

const fixtureDir = join(import.meta.dirname, "../fixtures");
const dockerAvailable = await isDockerAvailable();
const tempDirs: string[] = [];
const sessionIds: string[] = [];

afterEach(async () => {
  const manager = new SandboxManager({ image: "alpine:3.20" });

  await Promise.all(
    sessionIds.splice(0).map(async (sessionId) => {
      await manager.destroySandbox(sessionId);
    }),
  );
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("parseUnifiedDiff", () => {
  it("parses bare unified diff output", async () => {
    const diff = await fixture("greeter.exact.diff");
    const patches = parseUnifiedDiff(diff);

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      oldPath: "src/greeter.ts",
      newPath: "src/greeter.ts",
      hunks: [
        {
          originalStart: 4,
          originalCount: 6,
          newStart: 4,
          newCount: 7,
        },
      ],
    });
  });

  it("parses fenced diff output", async () => {
    const diff = await fixture("greeter.offset-plus-one.diff");
    const patches = parseUnifiedDiff(diff);

    expect(patches[0]?.newPath).toBe("src/greeter.ts");
    expect(patches[0]?.hunks[0]?.lines.at(-1)).toEqual({
      type: "context",
      content: "}",
    });
  });
});

describe("applyFilePatch", () => {
  it("applies exact hunks without fuzzy matching", async () => {
    const result = applyFilePatch(
      await fixture("greeter.before.ts"),
      onlyPatch(await fixture("greeter.exact.diff")),
    );

    expect(result.mode).toBe("exact");
    expect(result.content).toBe(await fixture("greeter.after.ts"));
  });

  it("applies offset hunks with fuzzy fallback", async () => {
    const result = applyFilePatch(
      await fixture("greeter.before.ts"),
      onlyPatch(await fixture("greeter.offset-plus-three.diff")),
    );

    expect(result.mode).toBe("fuzzy");
    expect(result.content).toBe(await fixture("greeter.after.ts"));
  });

  it("applies near-context hunks when confidence is high enough", async () => {
    const result = applyFilePatch(
      await fixture("greeter.before.ts"),
      onlyPatch(await fixture("greeter.near-context.diff")),
    );

    expect(result.mode).toBe("fuzzy");
    expect(result.content).toBe(await fixture("greeter.after.ts"));
  });

  it("creates a new file when oldPath is /dev/null", () => {
    const patch: FilePatch = {
      oldPath: "/dev/null",
      newPath: "src/new.ts",
      hunks: [
        {
          originalStart: 0,
          originalCount: 0,
          newStart: 1,
          newCount: 1,
          section: "",
          lines: [{ type: "add", content: "export const value = 1;" }],
        },
      ],
    };

    const result = applyFilePatch("", patch);

    expect(result.content).toBe("export const value = 1;");
    expect(result.mode).toBe("exact");
  });

  it("returns structured failures when no hunk match is confident enough", async () => {
    const patch = onlyPatch(await fixture("greeter.exact.diff"));
    const original = await fixture("greeter.before.ts");
    patch.hunks[0]?.lines.splice(0, patch.hunks[0].lines.length, {
      type: "context",
      content: "nothing in this file matches",
    });

    expect(() => applyFilePatch(original, patch)).toThrow(DiffApplyError);
  });

  it("applies every fixture variant successfully", async () => {
    const fixtureNames = [
      "greeter.exact.diff",
      "greeter.offset-plus-one.diff",
      "greeter.offset-plus-three.diff",
      "greeter.near-context.diff",
    ];
    let successes = 0;

    for (const fixtureName of fixtureNames) {
      const result = applyFilePatch(
        await fixture("greeter.before.ts"),
        onlyPatch(await fixture(fixtureName)),
      );

      if (result.content === (await fixture("greeter.after.ts"))) {
        successes += 1;
      }
    }

    expect(successes / fixtureNames.length).toBeGreaterThan(0.95);
  });
});

describe("DiffEngine", () => {
  it("reads and writes sandbox files through exec", async () => {
    const writes: string[] = [];
    const engine = new DiffEngine({
      async exec(_sessionId, command) {
        if (command.startsWith("cat --")) {
          return execResult(await fixture("greeter.before.ts"));
        }

        writes.push(command);
        return execResult("");
      },
    });

    await engine.apply("session-1", await fixture("greeter.exact.diff"));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("base64 -d > 'src/greeter.ts'");
  });

  it.skipIf(!dockerAvailable)(
    "applies patches inside a live sandbox volume",
    async () => {
      const repoPath = await makeTempRepo();
      const sessionId = `diff-${crypto.randomUUID()}`;
      const manager = new SandboxManager({ image: "alpine:3.20" });
      const engine = new DiffEngine(manager);

      sessionIds.push(sessionId);
      await writeRepoFile(
        repoPath,
        "src/greeter.ts",
        await fixture("greeter.before.ts"),
      );
      await manager.createSandbox(sessionId, repoPath);
      await engine.apply(sessionId, await fixture("greeter.exact.diff"));

      const result = await manager.exec(sessionId, "cat src/greeter.ts");
      const { stdout } = await collectSandboxExec(result);

      expect(stdout).toBe(await fixture("greeter.after.ts"));
    },
  );
});

function onlyPatch(diff: string): FilePatch {
  const patch = parseUnifiedDiff(diff)[0];

  if (!patch) {
    throw new Error("Expected one patch");
  }

  return structuredClone(patch);
}

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtureDir, name), "utf8");
}

function execResult(stdout: string): ExecResult {
  return {
    output: {
      async *[Symbol.asyncIterator]() {
        if (stdout) {
          yield { stream: "stdout" as const, data: stdout };
        }
      },
    },
    exitCode: Promise.resolve(0),
  };
}

async function makeTempRepo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "iquantum-diff-engine-"));
  tempDirs.push(directory);
  await mkdir(join(directory, ".git"), { recursive: true });
  return directory;
}

async function writeRepoFile(
  repoPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = join(repoPath, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function collectSandboxExec(result: ExecResult): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  let stdout = "";
  let stderr = "";

  for await (const chunk of result.output) {
    if (chunk.stream === "stdout") {
      stdout += chunk.data;
    } else {
      stderr += chunk.data;
    }
  }

  return {
    stdout,
    stderr,
    exitCode: await result.exitCode,
  };
}
