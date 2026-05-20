import type { SandboxManager } from "@iquantum/sandbox";
import { describe, expect, it, vi } from "vitest";
import { execResult } from "./common";
import { FileEditTool } from "./file-edit";
import { FileReadTool } from "./file-read";
import { FileWriteTool } from "./file-write";

describe("FileEditTool", () => {
  it("returns an error when old_string is missing", async () => {
    const sandbox = mockSandbox(["hello"]);
    const result = await makeTool().execute(
      { path: "a.txt", old_string: "missing", new_string: "next" },
      sandbox,
      "sess-1",
    );

    expect(result).toBe("Error: old_string not found in a.txt");
  });

  it("returns an error when old_string is not unique", async () => {
    const sandbox = mockSandbox(["hello hello"]);
    const result = await makeTool().execute(
      { path: "a.txt", old_string: "hello", new_string: "next" },
      sandbox,
      "sess-1",
    );

    expect(result).toBe(
      "Error: old_string is not unique in a.txt (found 2 occurrences)",
    );
  });

  it("reads, writes the replacement, and reports success", async () => {
    const sandbox = mockSandbox(["hello world", ""]);
    const result = await makeTool().execute(
      { path: "a.txt", old_string: "world", new_string: "there" },
      sandbox,
      "sess-1",
    );

    expect(result).toBe("Edited a.txt: replaced 1 occurrence");
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
    expect(sandbox.exec).toHaveBeenLastCalledWith(
      "sess-1",
      expect.stringContaining(Buffer.from("hello there").toString("base64")),
    );
  });
});

function makeTool(): FileEditTool {
  const read = new FileReadTool();
  return new FileEditTool(read, new FileWriteTool(1024));
}

function mockSandbox(outputs: string[]): Pick<SandboxManager, "exec"> {
  return {
    exec: vi.fn(async () => execResult(outputs.shift() ?? "")),
  };
}
