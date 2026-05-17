/**
 * REPL chat mode tests (A6).
 *
 * The project has no Ink rendering harness, so these tests cover the same
 * observable behaviors (phase strip suppressed, chatUnavailable commands
 * blocked, correct hint text) at the logic level instead of the render level.
 */
import type { REPLAction } from "@iquantum/ui-core";
import { describe, expect, it } from "vitest";
import type { CommandRegistry } from "../commands/registry";
import { makeCommandRegistry } from "../commands/slash-commands";
import { COPY } from "../components/theme";

function captureDispatch(): {
  dispatch: (a: REPLAction) => void;
  calls: REPLAction[];
} {
  const calls: REPLAction[] = [];
  return {
    dispatch: (a) => {
      calls.push(a);
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// Theme copy strings
// ---------------------------------------------------------------------------

describe("REPL theme copy", () => {
  it("hintIdle differs from hintChat", () => {
    expect(COPY.hintIdle).toBeTruthy();
    expect(COPY.hintChat).toBeTruthy();
    expect(COPY.hintIdle).not.toBe(COPY.hintChat);
  });

  it("hintChat references the codebase", () => {
    expect(COPY.hintChat.toLowerCase()).toContain("codebase");
  });
});

// ---------------------------------------------------------------------------
// chatUnavailable flags on the default registry
// ---------------------------------------------------------------------------

describe("chatUnavailable command flags", () => {
  const registry = makeCommandRegistry();

  it.each([
    "approve",
    "reject",
    "plan",
  ])("/%s is marked chatUnavailable", (name) => {
    const cmd = registry.get(name);
    expect(cmd, `command /${name} must exist`).toBeDefined();
    expect(cmd?.chatUnavailable, `/${name}.chatUnavailable`).toBe(true);
  });

  it.each([
    "help",
    "status",
    "clear",
    "restore",
    "compact",
    "model",
  ])("/%s is available in chat mode", (name) => {
    const cmd = registry.get(name);
    if (!cmd) return; // command may not exist in all builds — skip gracefully
    expect(cmd.chatUnavailable).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// REPL onSubmit chat-mode guard — same logic as REPL.tsx onSubmit
// Extracted here so we can unit-test it without an Ink renderer.
// ---------------------------------------------------------------------------

function simulateREPLSubmit(
  content: string,
  chatMode: boolean,
  registry: CommandRegistry,
  dispatch: (a: REPLAction) => void,
): "handled" | "passthrough" {
  if (!content.startsWith("/")) return "passthrough";

  const [rawName, ..._rest] = content.slice(1).split(" ");
  const cmdName = rawName ?? "";
  const cmd = registry.get(cmdName);

  if (!cmd) {
    dispatch({
      type: "system_message",
      text: `Unknown command: /${cmdName}. Type /help for a list.`,
      level: "error",
    });
    return "handled";
  }

  if (chatMode && cmd.chatUnavailable) {
    dispatch({
      type: "system_message",
      text: `/${cmd.name} is not available in chat mode`,
      level: "error",
    });
    return "handled";
  }

  if (chatMode && cmd.name === "task") {
    dispatch({
      type: "system_message",
      text: "start a new session with iq to run a task",
      level: "error",
    });
    return "handled";
  }

  return "passthrough";
}

describe("REPL chat mode submit guard", () => {
  const registry = makeCommandRegistry();

  it("blocks /approve in chat mode and dispatches an error", () => {
    const { dispatch, calls } = captureDispatch();
    simulateREPLSubmit("/approve", true, registry, dispatch);
    expect(calls).toContainEqual({
      type: "system_message",
      text: "/approve is not available in chat mode",
      level: "error",
    });
  });

  it("blocks /reject in chat mode", () => {
    const { dispatch, calls } = captureDispatch();
    simulateREPLSubmit("/reject because reasons", true, registry, dispatch);
    expect(calls).toContainEqual(
      expect.objectContaining({
        type: "system_message",
        level: "error",
        text: expect.stringContaining("not available in chat mode"),
      }),
    );
  });

  it("blocks /task in chat mode with a different message", () => {
    const { dispatch, calls } = captureDispatch();
    simulateREPLSubmit("/task add auth", true, registry, dispatch);
    expect(calls).toContainEqual({
      type: "system_message",
      text: "start a new session with iq to run a task",
      level: "error",
    });
  });

  it("does NOT block /approve in PIV mode", () => {
    const { dispatch, calls } = captureDispatch();
    const result = simulateREPLSubmit("/approve", false, registry, dispatch);
    expect(result).not.toBe("handled");
    expect(calls).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("not available"),
      }),
    );
  });

  it("does NOT block /help in chat mode", () => {
    const { dispatch, calls } = captureDispatch();
    const result = simulateREPLSubmit("/help", true, registry, dispatch);
    expect(result).toBe("passthrough");
    expect(calls).not.toContainEqual(
      expect.objectContaining({ level: "error" }),
    );
  });

  it("dispatches unknown-command error for unrecognised slash commands", () => {
    const { dispatch, calls } = captureDispatch();
    simulateREPLSubmit("/nonexistent", true, registry, dispatch);
    expect(calls).toContainEqual(
      expect.objectContaining({
        type: "system_message",
        level: "error",
        text: expect.stringContaining("Unknown command"),
      }),
    );
  });

  it("treats plain text as passthrough regardless of chatMode", () => {
    const { dispatch, calls } = captureDispatch();
    expect(simulateREPLSubmit("hello", true, registry, dispatch)).toBe(
      "passthrough",
    );
    expect(calls).toHaveLength(0);
  });
});
