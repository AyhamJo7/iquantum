import type { Session } from "@iquantum/types";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useReducer, useRef } from "react";
import type { DaemonClient } from "../client";
import { isDaemonNotRunning } from "../client";
import type { CommandRegistry } from "../commands/registry";
import { PermissionRequest } from "../components/PermissionRequest";
import { PromptInput } from "../components/PromptInput";
import { SpinnerWithPhase } from "../components/SpinnerWithPhase";
import { StatusBar } from "../components/StatusBar";
import { VirtualMessageList } from "../components/VirtualMessageList";
import type { TranscriptItem } from "./repl-state";
import { initialREPLViewState, reduceREPLViewState } from "./repl-state";

export interface REPLProps {
  client: DaemonClient;
  session: Session;
  modelName: string;
  editorModel: string;
  registry?: CommandRegistry;
  initialMessages?: TranscriptItem[];
}

export function REPL({
  client,
  session,
  modelName,
  editorModel,
  registry,
  initialMessages = [],
}: REPLProps) {
  const [state, dispatch] = useReducer(
    reduceREPLViewState,
    initialMessages,
    (msgs) => ({ ...initialREPLViewState, messages: msgs }),
  );
  const submittingRef = useRef(false);
  const lastCtrlCRef = useRef(0);

  const pendingPermission = useMemo(() => {
    if (!state.pendingPermissionId) return null;
    const item = state.messages.find(
      (m) =>
        m.type === "permission_request" &&
        m.requestId === state.pendingPermissionId &&
        !m.resolved,
    );
    return item?.type === "permission_request" ? item : null;
  }, [state.pendingPermissionId, state.messages]);

  useInput((input, key) => {
    if (key.ctrl && input === "o") {
      dispatch({ type: "toggle_thinking" });
      return;
    }

    if (key.ctrl && input === "c") {
      const now = Date.now();

      if (now - lastCtrlCRef.current < 500) {
        process.exit(0);
      }

      lastCtrlCRef.current = now;
      return;
    }

    if (key.ctrl && input === "l") {
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      return;
    }

    if (key.escape && state.isSubmitting) {
      submittingRef.current = false;
      dispatch({ type: "submit_error", message: "cancelled" });
      void client.cancelStream(session.id).catch(() => {});
    }
  });

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        for await (const frame of client.openStream(session.id)) {
          if (!active) {
            return;
          }

          dispatch({ type: "frame", frame });

          if (frame.type === "done" || frame.type === "error") {
            submittingRef.current = false;
          }
        }
      } catch (streamError) {
        if (active) {
          dispatch({
            type: "submit_error",
            message: isDaemonNotRunning(streamError)
              ? "Daemon disconnected. Run `iq daemon start` to reconnect."
              : streamError instanceof Error
                ? streamError.message
                : String(streamError),
          });
          submittingRef.current = false;
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [client, session.id]);

  return (
    <Box flexDirection="column">
      <VirtualMessageList
        items={state.messages}
        streamingText={state.streamingText}
        thinkingText={state.thinkingText}
        thinkingExpanded={state.thinkingExpanded}
      />
      {pendingPermission ? (
        <PermissionRequest
          requestId={pendingPermission.requestId}
          tool={pendingPermission.tool}
          input={pendingPermission.input}
          onResolve={async (requestId, approved) => {
            try {
              await client.postPermission(session.id, requestId, approved);
            } catch {
              // daemon may have already timed out the request; proceed locally
            }
            dispatch({ type: "permission_resolved", requestId, approved });
          }}
        />
      ) : (
        <SpinnerWithPhase {...(state.phase ? { phase: state.phase } : {})} />
      )}
      {state.error ? <Text color="red">{state.error}</Text> : null}
      <PromptInput
        disabled={state.isSubmitting}
        {...(registry ? { registry } : {})}
        onSubmit={async (content) => {
          if (content.startsWith("/") && registry) {
            const [rawName, ...argParts] = content.slice(1).split(" ");
            const cmdName = rawName ?? "";
            const cmd = registry.get(cmdName);

            if (cmd) {
              await cmd.run(argParts.join(" "), {
                client,
                registry,
                sessionId: session.id,
                dispatch,
                tokenCount: state.tokenCount,
                modelName,
                editorModel,
              });
              return;
            }

            dispatch({
              type: "system_message",
              text: `Unknown command: /${cmdName}. Type /help for a list.`,
              level: "error",
            });
            return;
          }

          if (submittingRef.current) {
            return;
          }

          submittingRef.current = true;
          dispatch({ type: "submitted", content });

          try {
            await client.postMessage(session.id, content);
          } catch (submitError) {
            dispatch({
              type: "submit_error",
              message:
                submitError instanceof Error
                  ? submitError.message
                  : String(submitError),
            });
            submittingRef.current = false;
          }
        }}
      />
      <StatusBar
        modelName={modelName}
        sessionId={session.id}
        tokenCount={state.tokenCount}
        mode="chat"
      />
    </Box>
  );
}
