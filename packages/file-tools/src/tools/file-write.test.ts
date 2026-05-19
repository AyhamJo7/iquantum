import type { SandboxManager } from "@iquantum/sandbox";
import { describe, expect, it, vi } from "vitest";
import { execResult } from "./common";
import { FileWriteTool } from "./file-write";

describe("FileWriteTool", () => {
  it("writes base64-encoded content", async () => {
    const sandbox = mockSandbox();
    const result = await new FileWriteTool(1024).execute(
      { path: "src/index.ts", content: "hello" },
      sandbox,
      "sess-1",
    );

    expect(result).toBe("Written 5 bytes to src/index.ts");
    expect(sandbox.exec).toHaveBeenCalledWith(
      "sess-1",
      expect.stringContaining(Buffer.from("hello").toString("base64")),
    );
  });

  it("enforces the byte limit before exec", async () => {
    const sandbox = mockSandbox();
    const result = await new FileWriteTool(3).execute(
      { path: "big.txt", content: "hello" },
      sandbox,
      "sess-1",
    );

    expect(result).toContain("exceeding the 3 byte limit");
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});

function mockSandbox(): Pick<SandboxManager, "exec"> {
  return {
    exec: vi.fn(async () => execResult("")),
  };
}
