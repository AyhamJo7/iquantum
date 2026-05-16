import { describe, expect, it } from "vitest";
import { initialREPLViewState, reduceREPLViewState } from "./repl-state";

describe("reduceREPLViewState", () => {
  it("locks submission until a done frame arrives", () => {
    const submitted = reduceREPLViewState(initialREPLViewState, {
      type: "submitted",
    });
    const done = reduceREPLViewState(submitted, {
      type: "frame",
      frame: { type: "done" },
    });

    expect(submitted.isSubmitting).toBe(true);
    expect(done.isSubmitting).toBe(false);
  });

  it("unlocks and records the error on error frames", () => {
    const errored = reduceREPLViewState(
      { ...initialREPLViewState, isSubmitting: true, phase: "requesting" },
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
});
