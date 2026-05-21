import { describe, expect, it } from "vitest";
import { initialREPLViewState, reduceREPLViewState } from "./repl-state";

describe("reduceREPLViewState", () => {
  it("streams assistant text into a live turn and finalizes on done", () => {
    const submitted = reduceREPLViewState(initialREPLViewState, {
      type: "submitted",
      content: "hello",
    });
    const streamed = reduceREPLViewState(submitted, {
      type: "frame",
      frame: { type: "token", delta: "hi" },
    });
    const done = reduceREPLViewState(streamed, {
      type: "frame",
      frame: { type: "done" },
    });

    expect(streamed.streamingText).toBe("hi");
    expect(done.isSubmitting).toBe(false);
    expect(done.messages).toMatchObject([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ]);
    expect(done.streamingText).toBe("");
  });

  it("collects thinking text separately and keeps it on the finalized assistant turn", () => {
    const submitted = reduceREPLViewState(initialREPLViewState, {
      type: "submitted",
      content: "explain",
    });
    const thinking = reduceREPLViewState(submitted, {
      type: "frame",
      frame: { type: "thinking", delta: "reasoning" },
    });
    const answered = reduceREPLViewState(thinking, {
      type: "frame",
      frame: { type: "token", delta: "answer" },
    });
    const done = reduceREPLViewState(answered, {
      type: "frame",
      frame: { type: "done" },
    });

    expect(done.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "answer",
      thinking: "reasoning",
    });
  });

  it("adds a compacted-context separator to the transcript", () => {
    const state = reduceREPLViewState(initialREPLViewState, {
      type: "frame",
      frame: { type: "compact_boundary", summary: "summary", tokenCount: 7 },
    });

    expect(state.messages).toMatchObject([
      { type: "compact_boundary", summary: "summary" },
    ]);
    expect(state.tokenCount).toBe(7);
  });

  it("unlocks and records the error on error frames", () => {
    const errored = reduceREPLViewState(
      {
        ...initialREPLViewState,
        isSubmitting: true,
        phase: "requesting",
      },
      {
        type: "frame",
        frame: { type: "error", message: "boom" },
      },
    );

    expect(errored).toMatchObject({
      error: "boom",
      isSubmitting: false,
    });
    expect(errored.phase).toBeUndefined();
  });

  it("clears streaming text when an error frame arrives mid-stream", () => {
    const streaming = reduceREPLViewState(
      reduceREPLViewState(initialREPLViewState, {
        type: "submitted",
        content: "hello",
      }),
      { type: "frame", frame: { type: "token", delta: "partial" } },
    );
    const errored = reduceREPLViewState(streaming, {
      type: "frame",
      frame: { type: "error", message: "oops" },
    });

    expect(errored.streamingText).toBe("");
    expect(errored.thinkingText).toBe("");
    expect(errored.isSubmitting).toBe(false);
  });

  it("does not add an assistant message when done arrives with no content", () => {
    const submitted = reduceREPLViewState(initialREPLViewState, {
      type: "submitted",
      content: "ping",
    });
    const done = reduceREPLViewState(submitted, {
      type: "frame",
      frame: { type: "done" },
    });

    expect(done.messages).toHaveLength(1);
    expect(done.messages[0]).toMatchObject({ role: "user", text: "ping" });
    expect(done.isSubmitting).toBe(false);
  });

  it("adds a diff_preview item to transcript", () => {
    const state = reduceREPLViewState(initialREPLViewState, {
      type: "frame",
      frame: {
        type: "diff_preview",
        file: "src/foo.ts",
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      type: "diff_preview",
      file: "src/foo.ts",
      patch: "@@ -1 +1 @@\n-old\n+new",
      addCount: 1,
      delCount: 1,
    });
  });

  it("adds a checkpoint row to transcript", () => {
    const state = reduceREPLViewState(initialREPLViewState, {
      type: "frame",
      frame: {
        type: "checkpoint",
        hash: "abc1234def",
        message: "feat: ship it",
      },
    });

    expect(state.messages[0]).toMatchObject({
      type: "checkpoint",
      hash: "abc1234def",
      message: "feat: ship it",
    });
    expect([...state.completedPhases]).toEqual([
      "planning",
      "implementing",
      "validating",
    ]);
  });

  it("system_message adds a system_message item", () => {
    const state = reduceREPLViewState(initialREPLViewState, {
      type: "system_message",
      text: "hello world",
      level: "info",
    });

    expect(state.messages[0]).toMatchObject({
      type: "system_message",
      text: "hello world",
      level: "info",
    });
  });

  it("review_finding adds a review card item", () => {
    const state = reduceREPLViewState(initialREPLViewState, {
      type: "review_finding",
      finding: {
        severity: "high",
        title: "Unsafe default",
        file: "src/auth.ts",
        line: 12,
        description: "The diff adds a bypass.",
        suggestion: "Require explicit configuration.",
      },
    });

    expect(state.messages[0]).toMatchObject({
      type: "review_finding",
      severity: "high",
      title: "Unsafe default",
    });
  });

  it("clear_transcript resets messages and streaming text", () => {
    const withMessages = reduceREPLViewState(
      reduceREPLViewState(initialREPLViewState, {
        type: "submitted",
        content: "hi",
      }),
      { type: "frame", frame: { type: "token", delta: "partial" } },
    );

    const cleared = reduceREPLViewState(withMessages, {
      type: "clear_transcript",
    });

    expect(cleared.messages).toHaveLength(0);
    expect(cleared.streamingText).toBe("");
    expect(cleared.error).toBeUndefined();
  });

  it("ignores token frames when state has an error (post-cancel guard)", () => {
    const withError = reduceREPLViewState(initialREPLViewState, {
      type: "submit_error",
      message: "cancelled",
    });
    const afterToken = reduceREPLViewState(withError, {
      type: "frame",
      frame: { type: "token", delta: "stale" },
    });

    expect(afterToken.streamingText).toBe("");
  });

  it("hydrate_history prepends items before current messages", () => {
    const withMessage = reduceREPLViewState(initialREPLViewState, {
      type: "submitted",
      content: "new message",
    });
    const hydrated = reduceREPLViewState(withMessage, {
      type: "hydrate_history",
      items: [
        { id: "hist-1", type: "message", role: "user", text: "old" },
        { id: "hist-sep", type: "session_separator" },
      ],
    });

    expect(hydrated.messages[0]).toMatchObject({ id: "hist-1" });
    expect(hydrated.messages[1]).toMatchObject({ type: "session_separator" });
    expect(hydrated.messages[2]).toMatchObject({
      type: "message",
      role: "user",
      text: "new message",
    });
  });

  it("tracks normal PIV phase progression", () => {
    const planning = reduceREPLViewState(initialREPLViewState, {
      type: "frame",
      frame: { type: "phase_change", phase: "planning" },
    });
    const implementing = reduceREPLViewState(planning, {
      type: "frame",
      frame: { type: "phase_change", phase: "implementing" },
    });
    const validating = reduceREPLViewState(implementing, {
      type: "frame",
      frame: { type: "phase_change", phase: "validating" },
    });

    expect([...validating.completedPhases]).toEqual([
      "planning",
      "implementing",
    ]);
  });

  it("does not complete planning when transitioning into requesting", () => {
    const requesting = reduceREPLViewState(
      {
        ...initialREPLViewState,
        phase: "planning",
      },
      {
        type: "frame",
        frame: { type: "phase_change", phase: "requesting" },
      },
    );

    expect([...requesting.completedPhases]).toEqual([]);
  });

  it("does not complete thinking when transitioning into implementing", () => {
    const implementing = reduceREPLViewState(
      {
        ...initialREPLViewState,
        phase: "thinking",
      },
      {
        type: "frame",
        frame: { type: "phase_change", phase: "implementing" },
      },
    );

    expect([...implementing.completedPhases]).toEqual([]);
  });

  it("increments retryCount without marking additional phases complete", () => {
    const validating = reduceREPLViewState(
      {
        ...initialREPLViewState,
        phase: "validating",
        completedPhases: new Set(["planning", "implementing"]),
      },
      {
        type: "frame",
        frame: { type: "validate_result", passed: false, attempt: 1 },
      },
    );

    expect(validating.retryCount).toBe(1);
    expect([...validating.completedPhases]).toEqual([
      "planning",
      "implementing",
    ]);
  });

  it("submitted resets PIV progress fields and records first submit", () => {
    const submitted = reduceREPLViewState(
      {
        ...initialREPLViewState,
        completedPhases: new Set(["planning", "implementing"]),
        retryCount: 2,
      },
      { type: "submitted", content: "new task" },
    );

    expect(submitted.completedPhases.size).toBe(0);
    expect(submitted.retryCount).toBe(0);
    expect(submitted.isFirstSubmit).toBe(true);
  });

  it("hydrate_history with a checkpoint infers all phases complete", () => {
    const hydrated = reduceREPLViewState(initialREPLViewState, {
      type: "hydrate_history",
      items: [
        {
          id: "checkpoint-1",
          type: "checkpoint",
          hash: "abc1234",
          message: "done",
        },
      ],
    });

    expect([...hydrated.completedPhases]).toEqual([
      "planning",
      "implementing",
      "validating",
    ]);
    expect(hydrated.isFirstSubmit).toBe(true);
  });

  it("ignores done frames when state has an error", () => {
    const withError = reduceREPLViewState(
      reduceREPLViewState(initialREPLViewState, {
        type: "submitted",
        content: "hi",
      }),
      { type: "submit_error", message: "cancelled" },
    );
    const afterDone = reduceREPLViewState(withError, {
      type: "frame",
      frame: { type: "done" },
    });

    expect(afterDone.isSubmitting).toBe(false); // was already false
    expect(afterDone.messages).toHaveLength(1); // only the user message
  });

  it("tracks pending permission and resolves it", () => {
    const pending = reduceREPLViewState(initialREPLViewState, {
      type: "frame",
      frame: {
        type: "permission_request",
        requestId: "req-1",
        tool: "bash",
        input: { command: "ls" },
      },
    });

    expect(pending.pendingPermissionId).toBe("req-1");
    expect(pending.messages[0]).toMatchObject({
      type: "permission_request",
      requestId: "req-1",
      tool: "bash",
      resolved: false,
    });

    const resolved = reduceREPLViewState(pending, {
      type: "permission_resolved",
      requestId: "req-1",
      approved: true,
    });

    expect(resolved.pendingPermissionId).toBeNull();
    expect(resolved.messages[0]).toMatchObject({
      type: "permission_request",
      resolved: true,
      approved: true,
    });
  });

  it("records approval_request frames in the transcript", () => {
    const state = reduceREPLViewState(initialREPLViewState, {
      type: "frame",
      frame: {
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
    });

    expect(state.messages[0]).toMatchObject({
      type: "approval_request",
      requestId: "approval-1",
      planId: "plan-1",
      status: "pending",
    });
  });

  it("renders v4 compaction and agent frames in transcript and roster state", () => {
    const compacted = reduceREPLViewState(initialREPLViewState, {
      type: "frame",
      frame: { type: "compaction", savedTokens: 42, strategy: "full" },
    });
    const spawned = reduceREPLViewState(compacted, {
      type: "frame",
      frame: {
        type: "agent_spawned",
        sessionId: "child-1",
        name: "worker-a",
        colorIndex: 1,
        coordinatorSessionId: "session-1",
      },
    });

    expect(compacted.messages[0]).toMatchObject({
      type: "system_message",
      text: "[compaction] Saved 42 tokens via full.",
    });
    expect(spawned.messages[1]).toMatchObject({
      type: "agent_spawn",
      name: "worker-a",
      sessionId: "child-1",
    });
    expect(spawned.agents[0]).toMatchObject({
      name: "worker-a",
      sessionId: "child-1",
      status: "running",
    });

    const updated = reduceREPLViewState(spawned, {
      type: "frame",
      frame: {
        type: "agent_status",
        sessionId: "child-1",
        name: "worker-a",
        status: "done",
        phase: "validating",
        turnIndex: 2,
        maxTurns: 4,
      },
    });

    const done = reduceREPLViewState(updated, {
      type: "frame",
      frame: {
        type: "agent_done",
        sessionId: "child-1",
        name: "worker-a",
        summary: "abc1234",
      },
    });

    expect(done.agents[0]).toMatchObject({
      status: "done",
      phase: "validating",
      turnIndex: 2,
      maxTurns: 4,
      summary: "abc1234",
    });

    const failed = reduceREPLViewState(done, {
      type: "frame",
      frame: {
        type: "agent_failed",
        sessionId: "child-1",
        name: "worker-a",
        error: "boom",
      },
    });

    expect(failed.agents[0]).toMatchObject({
      status: "failed",
      error: "boom",
    });
    expect(failed.messages.at(-1)).toMatchObject({
      type: "agent_error",
      name: "worker-a",
      error: "boom",
    });
  });
});
