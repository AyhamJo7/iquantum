import type { SandboxManager } from "@iquantum/sandbox";
import { describe, expect, it, vi } from "vitest";
import { execResult } from "./common";
import { FileGlobTool } from "./file-glob";

describe("FileGlobTool", () => {
  it("returns sorted relative paths from find output", async () => {
    const sandbox = mockSandbox("/workspace/a.ts\n/workspace/src/b.ts\n");
    const result = await new FileGlobTool().execute(
      { pattern: "*.ts" },
      sandbox,
      "sess-1",
    );

    expect(result).toBe("a.ts\nsrc/b.ts");
    expect(sandbox.exec).toHaveBeenCalledWith(
      "sess-1",
      "find '/workspace' -name '*.ts' -type f | sort",
    );
  });

  it("rejects shell metacharacters in patterns before exec", async () => {
    const sandbox = mockSandbox("");
    const result = await new FileGlobTool().execute(
      { pattern: "*.ts; rm -rf /" },
      sandbox,
      "sess-1",
    );

    expect(result).toContain("unsupported shell metacharacters");
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});

function mockSandbox(stdout: string): Pick<SandboxManager, "exec"> {
  return {
    exec: vi.fn(async () => execResult(stdout)),
  };
}
