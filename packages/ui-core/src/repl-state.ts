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
      type: "agent_spawn";
      sessionId: string;
      name: string;
      colorIndex: number;
    }
  | {
      id: string;
      type: "agent_error";
      sessionId: string;
      name: string;
      error: string;
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
  agents: AgentView[];
}

export interface AgentView {
  sessionId: string;
  name: string;
  colorIndex: number;
  status: "running" | "done" | "failed" | "killed";
  phase?: Phase | undefined;
  turnIndex?: number | undefined;
  maxTurns?: number | undefined;
  lastMessage?: string | undefined;
  summary?: string | undefined;
  error?: string | undefined;
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
  agents: [],
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
      return {
        ...state,
        agents: upsertAgent(state.agents, {
          sessionId: frame.sessionId,
          name: frame.name,
          colorIndex: frame.colorIndex,
          status: "running",
        }),
        messages: [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "agent_spawn",
            sessionId: frame.sessionId,
            name: frame.name,
            colorIndex: frame.colorIndex,
          },
        ],
        nextTranscriptId: state.nextTranscriptId + 1,
      };
    case "agent_status":
      return {
        ...state,
        agents: upsertAgent(state.agents, {
          sessionId: frame.sessionId,
          name: frame.name,
          status: frame.status,
          ...(frame.phase === undefined ? {} : { phase: frame.phase }),
          ...(frame.turnIndex === undefined
            ? {}
            : { turnIndex: frame.turnIndex }),
          ...(frame.maxTurns === undefined ? {} : { maxTurns: frame.maxTurns }),
        }),
      };
    case "agent_message":
      return {
        ...state,
        agents: upsertAgent(state.agents, {
          sessionId: frame.sessionId,
          name: frame.name,
          lastMessage: frame.content,
        }),
      };
    case "agent_done":
      return {
        ...state,
        agents: upsertAgent(state.agents, {
          sessionId: frame.sessionId,
          name: frame.name,
          status: "done",
          summary: frame.summary,
        }),
      };
    case "agent_failed":
      return {
        ...state,
        agents: upsertAgent(state.agents, {
          sessionId: frame.sessionId,
          name: frame.name,
          status: "failed",
          error: frame.error,
        }),
        messages: [
          ...state.messages,
          {
            id: transcriptId(state.nextTranscriptId),
            type: "agent_error",
            sessionId: frame.sessionId,
            name: frame.name,
            error: frame.error,
          },
        ],
        nextTranscriptId: state.nextTranscriptId + 1,
      };
    case "agent_killed":
      return {
        ...state,
        agents: upsertAgent(state.agents, {
          sessionId: frame.sessionId,
          name: frame.name,
          status: "killed",
          summary: frame.reason,
        }),
      };
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

function upsertAgent(
  agents: AgentView[],
  update: Partial<AgentView> & {
    sessionId: string;
    name: string;
  },
): AgentView[] {
  const index = agents.findIndex(
    (agent) => agent.sessionId === update.sessionId,
  );
  const existing = index === -1 ? undefined : agents[index];
  const next: AgentView = {
    sessionId: update.sessionId,
    name: update.name,
    colorIndex: update.colorIndex ?? existing?.colorIndex ?? 0,
    status: update.status ?? existing?.status ?? "running",
    ...((update.phase ?? existing?.phase)
      ? { phase: update.phase ?? existing?.phase }
      : {}),
    ...(update.turnIndex !== undefined || existing?.turnIndex !== undefined
      ? { turnIndex: update.turnIndex ?? existing?.turnIndex }
      : {}),
    ...(update.maxTurns !== undefined || existing?.maxTurns !== undefined
      ? { maxTurns: update.maxTurns ?? existing?.maxTurns }
      : {}),
    ...((update.lastMessage ?? existing?.lastMessage)
      ? { lastMessage: update.lastMessage ?? existing?.lastMessage }
      : {}),
    ...((update.summary ?? existing?.summary)
      ? { summary: update.summary ?? existing?.summary }
      : {}),
    ...((update.error ?? existing?.error)
      ? { error: update.error ?? existing?.error }
      : {}),
  };

  if (index === -1) {
    return [...agents, next];
  }

  return agents.map((agent, agentIndex) =>
    agentIndex === index ? next : agent,
  );
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
