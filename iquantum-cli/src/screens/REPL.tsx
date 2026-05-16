import type { Session } from "@iquantum/types";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useReducer, useRef } from "react";
import type { DaemonClient } from "../client";
import { PermissionRequest } from "../components/PermissionRequest";
import { PromptInput } from "../components/PromptInput";
import { SpinnerWithPhase } from "../components/SpinnerWithPhase";
import { StatusBar } from "../components/StatusBar";
import { VirtualMessageList } from "../components/VirtualMessageList";
import { initialREPLViewState, reduceREPLViewState } from "./repl-state";

export interface REPLProps {
  client: DaemonClient;
  session: Session;
  modelName: string;
}

export function REPL({ client, session, modelName }: REPLProps) {
  const [state, dispatch] = useReducer(
    reduceREPLViewState,
    initialREPLViewState,
  );
  const submittingRef = useRef(false);

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
            message:
              streamError instanceof Error
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
        onSubmit={async (content) => {
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
