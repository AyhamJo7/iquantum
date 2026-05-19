import type { SandboxManager } from "@iquantum/sandbox";
import { describe, expect, it, vi } from "vitest";
import { PathTraversalError } from "../sanitize";
import { execResult } from "./common";
import { FileReadTool } from "./file-read";

describe("FileReadTool", () => {
  it("reads numbered file output", async () => {
    const sandbox = mockSandbox("     1\thello\n     2\tworld\n");
    const result = await new FileReadTool().execute(
      { path: "README.md" },
      sandbox,
      "sess-1",
    );

    expect(result).toContain("README.md (lines 1-2):");
    expect(result).toContain("1\thello");
    expect(result).toContain("2\tworld");
    expect(sandbox.exec).toHaveBeenCalledWith(
      "sess-1",
      "cat -n -- '/workspace/README.md'",
    );
  });

  it("applies line windows", async () => {
    const sandbox = mockSandbox("     1\thello\n     2\tworld\n");
    const result = await new FileReadTool().execute(
      { path: "README.md", offset: 2, limit: 1 },
      sandbox,
      "sess-1",
    );

    expect(result).not.toContain("1\thello");
    expect(result).toContain("2\tworld");
  });

  it("rejects traversal before exec", async () => {
    const sandbox = mockSandbox("");

    await expect(
      new FileReadTool().execute({ path: "../etc/passwd" }, sandbox, "sess-1"),
    ).rejects.toBeInstanceOf(PathTraversalError);
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});

function mockSandbox(stdout: string): Pick<SandboxManager, "exec"> {
  return {
    exec: vi.fn(async () => execResult(stdout)),
  };
}
