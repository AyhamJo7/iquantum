import type { Phase, ServerStreamFrame } from "@iquantum/protocol";

export type TranscriptItem =
  | {
      id: string;
      type: "message";
      role: "user" | "assistant";
      text: string;
      thinking?: string | undefined;
    }
  | {
      id: string;
      type: "compact_boundary";
      summary: string;
    };

export interface REPLViewState {
  phase?: Phase | undefined;
  tokenCount: number;
  error?: string | undefined;
  isSubmitting: boolean;
  messages: TranscriptItem[];
  streamingText: string;
  thinkingText: string;
  thinkingExpanded: boolean;
  nextTranscriptId: number;
}

export type REPLAction =
  | { type: "submitted"; content: string }
  | { type: "submit_error"; message: string }
  | { type: "toggle_thinking" }
  | { type: "frame"; frame: ServerStreamFrame };

export const initialREPLViewState: REPLViewState = {
  tokenCount: 0,
  isSubmitting: false,
  messages: [],
  streamingText: "",
  thinkingText: "",
  thinkingExpanded: false,
  nextTranscriptId: 1,
};

export function reduceREPLViewState(
  state: REPLViewState,
  action: REPLAction,
): REPLViewState {
  switch (action.type) {
    case "submitted":
      return {
        ...state,
        error: undefined,
        isSubmitting: true,
        streamingText: "",
        thinkingText: "",
        messages: [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "message",
            role: "user",
            text: action.content,
          },
        ],
        nextTranscriptId: state.nextTranscriptId + 1,
      };
    case "submit_error":
      return {
        ...state,
        error: action.message,
        isSubmitting: false,
      };
    case "toggle_thinking":
      return {
        ...state,
        thinkingExpanded: !state.thinkingExpanded,
      };
    case "frame":
      return reduceFrame(state, action.frame);
  }
}

function reduceFrame(
  state: REPLViewState,
  frame: ServerStreamFrame,
): REPLViewState {
  switch (frame.type) {
    case "phase_change":
      return { ...state, phase: frame.phase };
    case "token":
      return {
        ...state,
        streamingText: `${state.streamingText}${frame.delta}`,
      };
    case "thinking":
      return { ...state, thinkingText: `${state.thinkingText}${frame.delta}` };
    case "compact_boundary":
      return {
        ...state,
        tokenCount: frame.tokenCount,
        messages: [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "compact_boundary",
            summary: frame.summary,
          },
        ],
        nextTranscriptId: state.nextTranscriptId + 1,
      };
    case "done":
      return finalizeAssistantTurn(state);
    case "error":
      return {
        ...state,
        error: frame.message,
        phase: undefined,
        isSubmitting: false,
        streamingText: "",
        thinkingText: "",
      };
    case "checkpoint":
    case "diff_preview":
    case "mcp_tool_call":
    case "permission_request":
    case "plan_ready":
    case "validate_result":
      return state;
  }
}

function finalizeAssistantTurn(state: REPLViewState): REPLViewState {
  const hasAssistantContent =
    state.streamingText.length > 0 || state.thinkingText.length > 0;

  return {
    ...state,
    phase: undefined,
    isSubmitting: false,
    streamingText: "",
    thinkingText: "",
    messages: hasAssistantContent
      ? [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "message",
            role: "assistant",
            text: state.streamingText,
            ...(state.thinkingText ? { thinking: state.thinkingText } : {}),
          },
        ]
      : state.messages,
    nextTranscriptId: hasAssistantContent
      ? state.nextTranscriptId + 1
      : state.nextTranscriptId,
  };
}

function transcriptId(nextId: number): string {
  return `transcript-${nextId}`;
}
