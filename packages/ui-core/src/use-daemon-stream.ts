import type { ServerStreamFrame } from "@iquantum/protocol";
import type { Dispatch } from "react";
import { useEffect, useState } from "react";
import type { REPLAction } from "./repl-state";

type BaseTransport =
  | { type: "sse"; url: string }
  | { type: "ws"; url: string }
  | { type: "iterator"; open: () => AsyncIterable<ServerStreamFrame> };

export function useDaemonStream(
  transport: BaseTransport,
  dispatch: Dispatch<REPLAction>,
): { connected: boolean; error: string | null } {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let source: EventSource | null = null;
    let socket: WebSocket | null = null;

    const onFrame = (frame: ServerStreamFrame) => {
      if (!active) return;
      dispatch({ type: "frame", frame });
    };

    if (transport.type === "sse") {
      const EventSourceCtor = EventSource as unknown as {
        new (url: string): EventSource;
      };
      source = new EventSourceCtor(transport.url);
      source.onopen = () => active && setConnected(true);
      source.onmessage = (event) =>
        onFrame(JSON.parse(event.data) as ServerStreamFrame);
      source.onerror = () => {
        if (active) setError("stream disconnected");
      };
    } else if (transport.type === "ws") {
      socket = new WebSocket(transport.url);
      socket.onopen = () => active && setConnected(true);
      socket.onmessage = (event) =>
        onFrame(JSON.parse(String(event.data)) as ServerStreamFrame);
      socket.onerror = () => active && setError("stream disconnected");
      socket.onclose = () => active && setConnected(false);
    } else {
      void (async () => {
        try {
          setConnected(true);
          for await (const frame of transport.open()) {
            if (!active) return;
            onFrame(frame);
          }
        } catch (streamError) {
          if (active) {
            setError(
              streamError instanceof Error
                ? streamError.message
                : String(streamError),
            );
          }
        } finally {
          if (active) setConnected(false);
        }
      })();
    }

    return () => {
      active = false;
      source?.close();
      socket?.close();
    };
  }, [dispatch, transport]);

  return { connected, error };
}
