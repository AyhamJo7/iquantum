import { useReducer } from "react";
import type { TranscriptItem } from "./repl-state";
import { initialREPLViewState, reduceREPLViewState } from "./repl-state";

export function useConversation(initialMessages: TranscriptItem[] = []) {
  const [state, dispatch] = useReducer(
    reduceREPLViewState,
    initialMessages,
    (messages) => ({ ...initialREPLViewState, messages }),
  );

  return { state, dispatch };
}
