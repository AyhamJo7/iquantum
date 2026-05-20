import type { SandboxManager } from "@iquantum/sandbox";
import { describe, expect, it, vi } from "vitest";
import { execResult } from "./common";
import { FileGrepTool } from "./file-grep";

describe("FileGrepTool", () => {
  it("rejects patterns longer than 1000 characters before exec", async () => {
    const sandbox = mockSandbox("");
    const result = await new FileGrepTool().execute(
      { pattern: "a".repeat(1001) },
      sandbox,
      "sess-1",
    );

    expect(result).toBe("Error: pattern exceeds 1000 characters");
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("executes grep and strips workspace prefixes", async () => {
    const sandbox = mockSandbox(
      '/workspace/src/a.ts:3:const base = "/workspace/src";\n',
    );
    const result = await new FileGrepTool().execute(
      { pattern: "base", path: "src", flags: "i" },
      sandbox,
      "sess-1",
    );

    expect(result).toBe('src/a.ts:3:const base = "/workspace/src";');
    expect(sandbox.exec).toHaveBeenCalledWith(
      "sess-1",
      "grep -rni -- 'base' '/workspace/src' 2>/dev/null | head -200",
    );
  });

  it("rejects grep flags that require separate arguments", async () => {
    const sandbox = mockSandbox("");
    const result = await new FileGrepTool().execute(
      { pattern: "test", flags: "m" },
      sandbox,
      "sess-1",
    );

    expect(result).toContain("Error: invalid grep input");
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});

function mockSandbox(stdout: string): Pick<SandboxManager, "exec"> {
  return {
    exec: vi.fn(async () => execResult(stdout)),
  };
}
