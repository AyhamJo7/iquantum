import type { Phase, ServerStreamFrame } from "@iquantum/protocol";

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

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
      addCount: number;
      delCount: number;
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
      type: "approval_request";
      requestId: string;
      planId: string;
      status: "pending" | "approved" | "rejected";
      feedback: string | null;
    }
  | {
      id: string;
      type: "checkpoint";
      hash: string;
      message: string;
    }
  | {
      id: string;
      type: "system_message";
      text: string;
      level: "info" | "error";
    }
  | {
      id: string;
      type: "review_finding";
      severity: ReviewSeverity;
      title: string;
      file: string;
      line: number | null;
      description: string;
      suggestion: string;
    }
  | { id: string; type: "session_separator" };

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
  completedPhases: Set<Phase>;
  retryCount: number;
  isFirstSubmit: boolean;
}

export type REPLAction =
  | { type: "submitted"; content: string }
  | { type: "submit_error"; message: string }
  | { type: "toggle_thinking" }
  | { type: "permission_resolved"; requestId: string; approved: boolean }
  | { type: "system_message"; text: string; level?: "info" | "error" }
  | {
      type: "review_finding";
      finding: {
        severity: ReviewSeverity;
        title: string;
        file: string;
        line: number | null;
        description: string;
        suggestion: string;
      };
    }
  | { type: "clear_transcript" }
  | { type: "hydrate_history"; items: TranscriptItem[] }
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
  completedPhases: new Set(),
  retryCount: 0,
  isFirstSubmit: false,
};

type PIVPhase = "planning" | "implementing" | "validating";

const PIV_PHASES = [
  "planning",
  "implementing",
  "validating",
] as const satisfies readonly PIVPhase[];
const PIV_PHASE_SET: ReadonlySet<Phase> = new Set(PIV_PHASES);

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
        completedPhases: new Set(),
        retryCount: 0,
        isFirstSubmit: true,
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
    case "review_finding":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "review_finding",
            ...action.finding,
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
    case "hydrate_history": {
      const hasCheckpoint = action.items.some(
        (item) => item.type === "checkpoint",
      );

      return {
        ...state,
        messages: [...action.items, ...state.messages],
        completedPhases: hasCheckpoint
          ? new Set(PIV_PHASES)
          : state.completedPhases,
        isFirstSubmit: hasCheckpoint ? true : state.isFirstSubmit,
      };
    }
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
      return {
        ...state,
        phase: frame.phase,
        completedPhases: withCompletedPreviousPhase(
          state.completedPhases,
          state.phase,
          frame.phase,
        ),
      };
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
    case "diff_preview": {
      const { addCount, delCount } = countDiffChanges(frame.patch);

      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "diff_preview",
            file: frame.file,
            patch: frame.patch,
            addCount,
            delCount,
          },
        ],
        nextTranscriptId: state.nextTranscriptId + 1,
      };
    }
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
    case "approval_request":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "approval_request",
            requestId: frame.request.id,
            planId: frame.request.planId,
            status: frame.request.status,
            feedback: frame.request.feedback,
          },
        ],
        nextTranscriptId: state.nextTranscriptId + 1,
      };
    case "compaction":
      return appendSystemFrame(
        state,
        `[compaction] Saved ${frame.savedTokens} tokens via ${frame.strategy}.`,
      );
    case "agent_spawned":
      return appendSystemFrame(
        state,
        `Spawned agent ${frame.name} (${frame.sessionId}).`,
      );
    case "agent_status": {
      const progress =
        frame.turnIndex === undefined || frame.maxTurns === undefined
          ? ""
          : ` ${frame.turnIndex}/${frame.maxTurns}`;
      return appendSystemFrame(
        state,
        `Agent ${frame.name} is ${frame.status}${frame.phase ? ` in ${frame.phase}` : ""}${progress}.`,
      );
    }
    case "agent_message":
      return appendSystemFrame(state, `Agent ${frame.name}: ${frame.content}`);
    case "agent_done":
      return appendSystemFrame(
        state,
        `Agent ${frame.name} finished: ${frame.summary}`,
      );
    case "agent_failed":
      return appendSystemFrame(
        state,
        `Agent ${frame.name} failed: ${frame.error}`,
        "error",
      );
    case "agent_killed":
      return appendSystemFrame(
        state,
        `Agent ${frame.name} stopped: ${frame.reason}`,
      );
    case "checkpoint":
      return {
        ...state,
        completedPhases: new Set(PIV_PHASES),
        messages: [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "checkpoint",
            hash: frame.hash,
            message: frame.message,
          },
        ],
        nextTranscriptId: state.nextTranscriptId + 1,
      };
    case "mcp_tool_call":
    case "tool_call":
    case "plan_ready":
      return state;
    case "validate_result":
      return frame.passed
        ? state
        : {
            ...state,
            retryCount: state.retryCount + 1,
          };
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

function withCompletedPreviousPhase(
  completedPhases: Set<Phase>,
  previousPhase: Phase | undefined,
  nextPhase: Phase,
): Set<Phase> {
  if (!previousPhase || !isPIVPhase(previousPhase) || !isPIVPhase(nextPhase)) {
    return completedPhases;
  }

  const previousIndex = PIV_PHASES.indexOf(previousPhase);
  const nextIndex = PIV_PHASES.indexOf(nextPhase);

  if (nextIndex <= previousIndex) {
    return completedPhases;
  }

  return new Set([...completedPhases, previousPhase]);
}

function isPIVPhase(phase: Phase): phase is PIVPhase {
  return PIV_PHASE_SET.has(phase);
}

function transcriptId(nextId: number): string {
  return `transcript-${nextId}`;
}

function appendSystemFrame(
  state: REPLViewState,
  text: string,
  level: "info" | "error" = "info",
): REPLViewState {
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: transcriptId(state.nextTranscriptId),
        type: "system_message",
        text,
        level,
      },
    ],
    nextTranscriptId: state.nextTranscriptId + 1,
  };
}

function countDiffChanges(patch: string): {
  addCount: number;
  delCount: number;
} {
  let addCount = 0;
  let delCount = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) addCount += 1;
    if (line.startsWith("-")) delCount += 1;
  }

  return { addCount, delCount };
}
