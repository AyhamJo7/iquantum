import type { PIVEngineEventMap } from "@iquantum/piv-engine";
import { z } from "zod";
import type { SessionEngine } from "./session-controller";

export interface StreamSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type ServerStreamFrame =
  | { type: "token"; delta: string }
  | { type: "phase_change"; phase: string }
  | { type: "plan_ready"; planId: string }
  | { type: "validate_result"; passed: boolean; attempt: number }
  | { type: "checkpoint"; hash: string }
  | { type: "error"; message: string };

const clientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve_plan"), planId: z.string().min(1) }),
  z.object({
    type: z.literal("reject_plan"),
    planId: z.string().min(1),
    feedback: z.string().min(1),
  }),
]);

export class StreamController {
  readonly #sessions: StreamSessions;
  readonly #sockets = new Set<StreamSocket>();

  constructor(sessions: StreamSessions) {
    this.#sessions = sessions;
  }

  attach(sessionId: string, socket: StreamSocket): () => void {
    const engine = this.#sessions.getEngine(sessionId);
    const subscriptions = subscribe(engine.events, {
      token: ({ token }) => this.#send(socket, { type: "token", delta: token }),
      phase_change: ({ to }) =>
        this.#send(socket, { type: "phase_change", phase: to }),
      plan_ready: (plan) =>
        this.#send(socket, { type: "plan_ready", planId: plan.id }),
      validate_result: (run) =>
        this.#send(socket, {
          type: "validate_result",
          passed: run.passed,
          attempt: run.attempt,
        }),
      checkpoint: (checkpoint) =>
        this.#send(socket, { type: "checkpoint", hash: checkpoint.commitHash }),
      error: (error) =>
        this.#send(socket, { type: "error", message: error.message }),
    });

    this.#sockets.add(socket);

    return () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }

      this.#sockets.delete(socket);
    };
  }

  async handleMessage(sessionId: string, rawMessage: string): Promise<void> {
    const frame = clientFrameSchema.parse(JSON.parse(rawMessage) as unknown);

    if (frame.type === "approve_plan") {
      await this.#sessions.approve(sessionId, frame.planId);
      return;
    }

    await this.#sessions.reject(sessionId, frame.feedback, frame.planId);
  }

  closeAll(): void {
    for (const socket of this.#sockets) {
      socket.close(1001, "daemon shutting down");
    }

    this.#sockets.clear();
  }

  #send(socket: StreamSocket, frame: ServerStreamFrame): void {
    socket.send(JSON.stringify(frame));
  }
}

export interface StreamSessions {
  getEngine(sessionId: string): SessionEngine;
  approve(sessionId: string, planId?: string): Promise<void>;
  reject(
    sessionId: string,
    feedback: string,
    planId?: string,
  ): Promise<unknown>;
}

function subscribe(
  events: import("node:events").EventEmitter<PIVEngineEventMap>,
  handlers: {
    [K in keyof PIVEngineEventMap]: (...args: PIVEngineEventMap[K]) => void;
  },
): Array<() => void> {
  return (Object.keys(handlers) as Array<keyof PIVEngineEventMap>).map(
    (eventName) => {
      const handler = handlers[eventName];
      events.on(eventName, handler);
      return () => events.off(eventName, handler);
    },
  );
}
