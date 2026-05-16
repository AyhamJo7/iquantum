import { describe, expect, it } from "vitest";
import type { ServerStreamFrame } from "./index";

describe("ServerStreamFrame", () => {
  it("covers existing and v2 SSE frames", () => {
    const frames = [
      { type: "token", delta: "hello" },
      { type: "phase_change", phase: "thinking" },
      { type: "plan_ready", planId: "plan-1" },
      { type: "validate_result", passed: true, attempt: 1 },
      { type: "checkpoint", hash: "abc1234" },
      { type: "error", message: "boom" },
      { type: "thinking", delta: "reasoning" },
      { type: "diff_preview", file: "src/a.ts", patch: "+line" },
      {
        type: "permission_request",
        requestId: "request-1",
        tool: "write_file",
        input: { file: "src/a.ts" },
      },
      { type: "compact_boundary", summary: "summary" },
      { type: "mcp_tool_call", server: "context7", tool: "resolve" },
      { type: "done" },
    ] satisfies ServerStreamFrame[];

    expect(frames.map((frame) => frame.type)).toEqual([
      "token",
      "phase_change",
      "plan_ready",
      "validate_result",
      "checkpoint",
      "error",
      "thinking",
      "diff_preview",
      "permission_request",
      "compact_boundary",
      "mcp_tool_call",
      "done",
    ]);
  });
});
