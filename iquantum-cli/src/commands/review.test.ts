import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../client";
import {
  parseReviewArgs,
  reviewTargetFromOptions,
  runReviewCommand,
} from "./review";

describe("review command", () => {
  it("parses slash-style review targets", () => {
    expect(parseReviewArgs("")).toEqual({ type: "staged" });
    expect(parseReviewArgs("commit HEAD")).toEqual({
      type: "commit",
      ref: "HEAD",
    });
    expect(parseReviewArgs("--path src/auth.ts")).toEqual({
      type: "path",
      path: "src/auth.ts",
    });
    expect(parseReviewArgs("pr 42")).toEqual({ type: "pr", ref: "42" });
  });

  it("rejects multiple top-level targets", () => {
    expect(() =>
      reviewTargetFromOptions({ commit: "HEAD", path: "src/auth.ts" }),
    ).toThrow("Choose only one review target");
  });

  it("creates a temporary session, streams review output, and destroys it", async () => {
    const calls: unknown[][] = [];
    const output: string[] = [];
    const client: Partial<DaemonClient> = {
      async createSession(repoPath, options) {
        calls.push(["createSession", repoPath, options]);
        return { id: "session-1" } as Awaited<
          ReturnType<DaemonClient["createSession"]>
        >;
      },
      async destroySession(sessionId) {
        calls.push(["destroySession", sessionId]);
      },
      async *reviewSession(sessionId, target) {
        calls.push(["reviewSession", sessionId, target]);
        yield {
          severity: "critical",
          title: "Hardcoded key",
          file: "src/auth.ts",
          line: 8,
          description: "A secret is committed.",
          suggestion: "Read it from config.",
        };
        yield { type: "done", summary: "Security issue.", durationMs: 1000 };
      },
    };

    await runReviewCommand(
      { repo: "/repo", staged: true },
      client as DaemonClient,
      writer(output),
    );

    expect(calls).toEqual([
      ["createSession", "/repo", { mode: "chat" }],
      ["reviewSession", "session-1", { type: "staged" }],
      ["destroySession", "session-1"],
    ]);
    expect(output.join("")).toContain("Reviewing staged changes");
    expect(output.join("")).toContain("[CRITICAL] Hardcoded key");
    expect(output.join("")).toContain("Review complete: 1 finding");
  });

  it("reports daemon startup guidance when the daemon is unavailable", async () => {
    const output: string[] = [];
    const client: Partial<DaemonClient> = {
      createSession: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }),
        ),
      destroySession: vi.fn(),
    };

    await runReviewCommand({}, client as DaemonClient, writer(output));

    expect(output.join("")).toContain("daemon is not running");
    expect(client.destroySession).not.toHaveBeenCalled();
  });
});

function writer(output: string[]) {
  return {
    write: (chunk: string) => output.push(chunk),
    writeln: (line: string) => output.push(`${line}\n`),
  };
}
