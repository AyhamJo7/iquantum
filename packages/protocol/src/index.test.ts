import { describe, expect, it } from "vitest";
import type { ServerStreamFrame } from "./index";

describe("ServerStreamFrame", () => {
  it("covers existing and v2 SSE frames", () => {
    const frames = [
      { type: "token", delta: "hello" },
      { type: "phase_change", phase: "thinking" },
      { type: "plan_ready", planId: "plan-1" },
      { type: "validate_result", passed: true, attempt: 1 },
      { type: "checkpoint", hash: "abc1234", message: "done" },
      { type: "error", message: "boom" },
      { type: "thinking", delta: "reasoning" },
      { type: "diff_preview", file: "src/a.ts", patch: "+line" },
      {
        type: "permission_request",
        requestId: "request-1",
        tool: "write_file",
        input: { file: "src/a.ts" },
      },
      {
        type: "approval_request",
        request: {
          id: "approval-1",
          sessionId: "session-1",
          planId: "plan-1",
          planContent: "ship it",
          createdAt: "2026-05-21T00:00:00.000Z",
          expiresAt: "2026-05-21T00:30:00.000Z",
          status: "pending",
          feedback: null,
        },
      },
      { type: "compact_boundary", summary: "summary", tokenCount: 7 },
      { type: "compaction", savedTokens: 42, strategy: "snip" },
      {
        type: "agent_spawned",
        sessionId: "child-1",
        name: "worker-a",
        colorIndex: 1,
        coordinatorSessionId: "session-1",
      },
      {
        type: "agent_status",
        sessionId: "child-1",
        name: "worker-a",
        status: "running",
        phase: "implementing",
        turnIndex: 2,
        maxTurns: 5,
      },
      {
        type: "agent_message",
        sessionId: "child-1",
        name: "worker-a",
        content: "working",
      },
      {
        type: "agent_done",
        sessionId: "child-1",
        name: "worker-a",
        summary: "tests passed",
      },
      {
        type: "agent_failed",
        sessionId: "child-2",
        name: "worker-b",
        error: "boom",
      },
      {
        type: "agent_killed",
        sessionId: "child-3",
        name: "worker-c",
        reason: "cancelled",
      },
      { type: "mcp_tool_call", server: "context7", tool: "resolve", input: {} },
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
      "approval_request",
      "compact_boundary",
      "compaction",
      "agent_spawned",
      "agent_status",
      "agent_message",
      "agent_done",
      "agent_failed",
      "agent_killed",
      "mcp_tool_call",
      "done",
    ]);
  });
});
