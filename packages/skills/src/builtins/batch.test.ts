import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IquantumConfig } from "@iquantum/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batchSkill } from "./batch";

let repoPath: string;
let otherPath: string;

beforeEach(async () => {
  repoPath = join(tmpdir(), `iq-batch-repo-${crypto.randomUUID()}`);
  otherPath = join(tmpdir(), `iq-batch-other-${crypto.randomUUID()}`);
  await mkdir(repoPath, { recursive: true });
  await mkdir(otherPath, { recursive: true });
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
  await rm(otherPath, { recursive: true, force: true });
});

describe("batchSkill", () => {
  it("matches files relative to ctx.repoPath instead of process.cwd", async () => {
    await writeFile(join(repoPath, "target.ts"), "export const ok = true;\n");
    await writeFile(
      join(otherPath, "wrong.ts"),
      "export const wrong = true;\n",
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(otherPath);
    const postMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await batchSkill.run('--files "*.ts" --prompt "Review this"', {
        sessionId: "session-1",
        client: {
          createMemory: vi.fn(),
          exportSession: vi.fn(),
          postMessage,
        },
        args: '--files "*.ts" --prompt "Review this"',
        dispatch: vi.fn(),
        config: {} as IquantumConfig,
        repoPath,
      });
    } finally {
      cwd.mockRestore();
    }

    expect(postMessage).toHaveBeenCalledWith(
      "session-1",
      ["Review this", "", "Context file:", "file_read target.ts"].join("\n"),
    );
  });
});
