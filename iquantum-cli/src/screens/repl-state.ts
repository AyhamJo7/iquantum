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
    }
  | {
      id: string;
      type: "diff_preview";
      file: string;
      patch: string;
    }
  | {
      id: string;
      type: "permission_request";
      requestId: string;
      tool: string;
      input: unknown;
      resolved: boolean;
      approved?: boolean;
    }
  | {
      id: string;
      type: "checkpoint";
      hash: string;
    }
  | {
      id: string;
      type: "system_message";
      text: string;
      level: "info" | "error";
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
  pendingPermissionId: string | null;
}

export type REPLAction =
  | { type: "submitted"; content: string }
  | { type: "submit_error"; message: string }
  | { type: "toggle_thinking" }
  | { type: "permission_resolved"; requestId: string; approved: boolean }
  | { type: "system_message"; text: string; level?: "info" | "error" }
  | { type: "clear_transcript" }
  | { type: "frame"; frame: ServerStreamFrame };

export const initialREPLViewState: REPLViewState = {
  tokenCount: 0,
  isSubmitting: false,
  messages: [],
  streamingText: "",
  thinkingText: "",
  thinkingExpanded: false,
  nextTranscriptId: 1,
  pendingPermissionId: null,
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
    case "permission_resolved":
      return {
        ...state,
        pendingPermissionId: null,
        messages: state.messages.map((m) =>
          m.type === "permission_request" && m.requestId === action.requestId
            ? { ...m, resolved: true, approved: action.approved }
            : m,
        ),
      };
    case "system_message":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "system_message",
            text: action.text,
            level: action.level ?? "info",
          },
        ],
        nextTranscriptId: state.nextTranscriptId + 1,
      };
    case "clear_transcript":
      return {
        ...state,
        messages: [],
        streamingText: "",
        thinkingText: "",
        error: undefined,
        pendingPermissionId: null,
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
      if (state.error) return state;
      return {
        ...state,
        streamingText: `${state.streamingText}${frame.delta}`,
      };
    case "thinking":
      if (state.error) return state;
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
      if (state.error) return state;
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
    case "diff_preview":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "diff_preview",
            file: frame.file,
            patch: frame.patch,
          },
        ],
        nextTranscriptId: state.nextTranscriptId + 1,
      };
    case "permission_request":
      return {
        ...state,
        pendingPermissionId: frame.requestId,
        messages: [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "permission_request",
            requestId: frame.requestId,
            tool: frame.tool,
            input: frame.input,
            resolved: false,
          },
        ],
        nextTranscriptId: state.nextTranscriptId + 1,
      };
    case "checkpoint":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "checkpoint",
            hash: frame.hash,
          },
        ],
        nextTranscriptId: state.nextTranscriptId + 1,
      };
    case "mcp_tool_call":
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
