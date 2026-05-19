import { describe, expect, it } from "vitest";
import { PathTraversalError, sanitizeSandboxPath } from "./sanitize";

describe("sanitizeSandboxPath", () => {
  it("normalizes clean relative paths into /workspace", () => {
    expect(sanitizeSandboxPath("src/index.ts")).toBe("/workspace/src/index.ts");
    expect(sanitizeSandboxPath("a/b/../c")).toBe("/workspace/a/c");
  });

  it("accepts paths already inside /workspace", () => {
    expect(sanitizeSandboxPath("/workspace/src/index.ts")).toBe(
      "/workspace/src/index.ts",
    );
  });

  it("rejects traversal attempts and absolute host paths", () => {
    expect(() => sanitizeSandboxPath("../etc/passwd")).toThrow(
      PathTraversalError,
    );
    expect(() => sanitizeSandboxPath("../../secret")).toThrow(
      PathTraversalError,
    );
    expect(() => sanitizeSandboxPath("/etc/passwd")).toThrow(
      PathTraversalError,
    );
    expect(() =>
      sanitizeSandboxPath("/workspace/foo/../../etc/passwd"),
    ).toThrow(PathTraversalError);
    expect(() => sanitizeSandboxPath("")).toThrow(PathTraversalError);
  });
});
