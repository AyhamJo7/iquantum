import { useConversation } from "@iquantum/ui-core";
import { useEffect } from "react";
import { MessageList } from "./components/MessageList";
import { PhaseStrip } from "./components/PhaseStrip";
import { PromptInput } from "./components/PromptInput";

declare const acquireVsCodeApi: () => { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

export function App() {
  const { state, dispatch } = useConversation();

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data.type === "frame") {
        dispatch({ type: "frame", frame: event.data.frame });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [dispatch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        dispatch({ type: "toggle_thinking" });
        vscode.postMessage({ type: "toggleThinking" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  return (
    <div className="app">
      <MessageList
        items={state.messages}
        streamingText={state.streamingText}
        thinkingText={state.thinkingText}
      />
      {state.isFirstSubmit ? (
        <PhaseStrip
          activePhase={state.phase ?? null}
          completedPhases={state.completedPhases}
        />
      ) : null}
      <PromptInput
        disabled={state.isSubmitting}
        onSubmit={(content) => {
          dispatch({ type: "submitted", content });
          vscode.postMessage({ type: "submit", content });
        }}
      />
    </div>
  );
}
