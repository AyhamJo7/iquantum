import type { Session } from "@iquantum/types";
import { Box, Text } from "ink";
import { useEffect, useReducer, useRef } from "react";
import type { DaemonClient } from "../client";
import { MessageList } from "../components/MessageList";
import { PromptInput } from "../components/PromptInput";
import { SpinnerWithPhase } from "../components/SpinnerWithPhase";
import { StatusBar } from "../components/StatusBar";
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
      <MessageList />
      <SpinnerWithPhase {...(state.phase ? { phase: state.phase } : {})} />
      {state.error ? <Text color="red">{state.error}</Text> : null}
      <PromptInput
        disabled={state.isSubmitting}
        onSubmit={async (content) => {
          if (submittingRef.current) {
            return;
          }

          submittingRef.current = true;
          dispatch({ type: "submitted" });

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
