import { describe, expect, it } from "vitest";
import { PermissionGate } from "./permission-gate";

describe("PermissionGate", () => {
  it("emits a request and resolves the approve path", async () => {
    const frames: unknown[] = [];
    const gate = new PermissionGate({
      publish(_sessionId, frame) {
        frames.push(frame);
      },
    });
    const result = gate.requestPermission(
      "session-1",
      "request-1",
      "apply_diff",
      { files: ["src/a.ts"] },
    );

    gate.resolvePermission("session-1", "request-1", true);

    await expect(result).resolves.toBe(true);
    expect(frames).toEqual([
      {
        type: "permission_request",
        requestId: "request-1",
        tool: "apply_diff",
        input: { files: ["src/a.ts"] },
      },
    ]);
  });

  it("resolves false when rejected", async () => {
    const gate = silentGate();
    const result = gate.requestPermission(
      "session-1",
      "request-1",
      "apply_diff",
      {},
    );

    gate.resolvePermission("session-1", "request-1", false);

    await expect(result).resolves.toBe(false);
  });

  it("fails closed when a request times out", async () => {
    const gate = silentGate();

    await expect(
      gate.requestPermission(
        "session-1",
        "request-1",
        "apply_diff",
        {},
        {
          timeoutMs: 0,
        },
      ),
    ).resolves.toBe(false);
  });

  it("drainAll resolves all pending requests as rejected and clears timers", async () => {
    const gate = silentGate();
    const first = gate.requestPermission(
      "session-1",
      "req-1",
      "apply_diff",
      {},
    );
    const second = gate.requestPermission(
      "session-2",
      "req-2",
      "apply_diff",
      {},
    );

    gate.drainAll();

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });

  it("returns immediately without publishing in auto-approve mode", async () => {
    const frames: unknown[] = [];
    const gate = new PermissionGate({
      publish(_sessionId, frame) {
        frames.push(frame);
      },
    });

    await expect(
      gate.requestPermission(
        "session-1",
        "request-1",
        "apply_diff",
        {},
        {
          autoApprove: true,
        },
      ),
    ).resolves.toBe(true);
    expect(frames).toEqual([]);
  });
});

function silentGate(): PermissionGate {
  return new PermissionGate({
    publish() {
      return undefined;
    },
  });
}
