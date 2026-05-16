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
    });
  });

  it("adds a checkpoint row to transcript", () => {
    const state = reduceREPLViewState(initialREPLViewState, {
      type: "frame",
      frame: { type: "checkpoint", hash: "abc1234def" },
    });

    expect(state.messages[0]).toMatchObject({
      type: "checkpoint",
      hash: "abc1234def",
    });
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
});
