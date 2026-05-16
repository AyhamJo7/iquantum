import { EventEmitter } from "node:events";
import type { PIVEngineEventMap } from "@iquantum/piv-engine";
import type { Plan } from "@iquantum/types";
import { describe, expect, it } from "vitest";
import { StreamController, type StreamSocket } from "./stream-controller";

describe("StreamController", () => {
  it("fans out engine events as JSON frames and detaches cleanly", () => {
    const events = new EventEmitter<PIVEngineEventMap>();
    const sent: string[] = [];
    const controller = new StreamController({
      getEngine() {
        return fakeEngine(events);
      },
    });
    const socket = fakeSocket(sent);
    const detach = controller.attach("session-1", socket);

    events.emit("phase_change", { from: "idle", to: "planning" });
    events.emit("token", { phase: "plan", token: "hello" });
    events.emit("plan_ready", fakePlan());
    detach();
    events.emit("phase_change", {
      from: "planning",
      to: "awaiting_approval",
    });

    expect(sent.map((frame) => JSON.parse(frame) as unknown)).toEqual([
      { type: "phase_change", phase: "planning" },
      { type: "token", delta: "hello" },
      { type: "plan_ready", planId: "plan-1" },
    ]);
  });

  it("publishes direct frames and closes a clean PIV stream after checkpointing", () => {
    const events = new EventEmitter<PIVEngineEventMap>();
    const sent: string[] = [];
    const controller = new StreamController({
      getEngine() {
        return fakeEngine(events);
      },
    });
    controller.attach("session-1", fakeSocket(sent));

    controller.publish("session-1", { type: "token", delta: "chat" });
    events.emit("checkpoint", {
      id: "checkpoint-1",
      sessionId: "session-1",
      validateRunId: "run-1",
      commitHash: "abc1234",
      commitMessage: "done",
      createdAt: "2026-05-16T00:00:00.000Z",
    });

    expect(sent.map((frame) => JSON.parse(frame) as unknown)).toEqual([
      { type: "token", delta: "chat" },
      { type: "checkpoint", hash: "abc1234", message: "done" },
      { type: "done" },
    ]);
  });
});

function fakeSocket(sent: string[]): StreamSocket {
  return {
    send(data) {
      sent.push(data);
    },
    close() {
      return undefined;
    },
  };
}

function fakeEngine(events: EventEmitter<PIVEngineEventMap>) {
  return {
    status: "idle" as const,
    currentPlan: undefined,
    events,
    async startTask() {
      return fakePlan();
    },
    async approve() {
      return undefined;
    },
    async reject() {
      return fakePlan();
    },
  };
}

function fakePlan(): Plan {
  return {
    id: "plan-1",
    sessionId: "session-1",
    content: "plan",
    status: "pending",
    feedback: null,
    createdAt: "2026-05-15T00:00:00.000Z",
    approvedAt: null,
  };
}
