import type { PIVEngineEventMap } from "@iquantum/piv-engine";
import type { Phase, ServerStreamFrame } from "@iquantum/protocol";
import type { SessionStatus } from "@iquantum/types";
import type { SessionEngine } from "./session-controller";

export interface StreamSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export class StreamController {
  readonly #sessions: StreamSessions;
  readonly #sockets = new Set<StreamSocket>();
  readonly #socketsBySession = new Map<string, Set<StreamSocket>>();

  constructor(sessions: StreamSessions) {
    this.#sessions = sessions;
  }

  attach(sessionId: string, socket: StreamSocket): () => void {
    const engine = this.#sessions.getEngine(sessionId);
    const subscriptions = subscribe(engine.events, {
      token: ({ token }) => this.#send(socket, { type: "token", delta: token }),
      phase_change: ({ to }) => {
        const phase = toProtocolPhase(to);

        if (phase) {
          this.#send(socket, { type: "phase_change", phase });
        }
      },
      plan_ready: (plan) =>
        this.#send(socket, { type: "plan_ready", planId: plan.id }),
      validate_result: (run) =>
        this.#send(socket, {
          type: "validate_result",
          passed: run.passed,
          attempt: run.attempt,
        }),
      checkpoint: (checkpoint) => {
        this.#send(socket, {
          type: "checkpoint",
          hash: checkpoint.commitHash,
        });
        this.#send(socket, { type: "done" });
      },
      diff_preview: (preview) =>
        this.#send(socket, {
          type: "diff_preview",
          file: preview.file,
          patch: preview.patch,
        }),
      error: (error) =>
        this.#send(socket, { type: "error", message: error.message }),
    });

    this.#sockets.add(socket);
    const sessionSockets = this.#socketsBySession.get(sessionId) ?? new Set();
    sessionSockets.add(socket);
    this.#socketsBySession.set(sessionId, sessionSockets);

    return () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }

      this.#sockets.delete(socket);
      sessionSockets.delete(socket);

      if (sessionSockets.size === 0) {
        this.#socketsBySession.delete(sessionId);
      }
    };
  }

  publish(sessionId: string, frame: ServerStreamFrame): void {
    for (const socket of this.#socketsBySession.get(sessionId) ?? []) {
      this.#send(socket, frame);
    }
  }

  closeAll(): void {
    for (const socket of this.#sockets) {
      socket.close(1001, "daemon shutting down");
    }

    this.#sockets.clear();
    this.#socketsBySession.clear();
  }

  #send(socket: StreamSocket, frame: ServerStreamFrame): void {
    socket.send(JSON.stringify(frame));
  }
}

function toProtocolPhase(status: SessionStatus): Phase | undefined {
  switch (status) {
    case "planning":
    case "implementing":
    case "validating":
      return status;
    case "idle":
    case "awaiting_approval":
    case "completed":
    case "error":
      return undefined;
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
