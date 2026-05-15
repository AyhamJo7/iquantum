import type { PIVEngineEventMap } from "@iquantum/piv-engine";
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
