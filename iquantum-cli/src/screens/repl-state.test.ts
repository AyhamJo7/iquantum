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
});
