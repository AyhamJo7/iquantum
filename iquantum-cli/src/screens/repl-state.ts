import type { Phase, ServerStreamFrame } from "@iquantum/protocol";

export interface REPLViewState {
  phase?: Phase | undefined;
  tokenCount: number;
  error?: string | undefined;
  isSubmitting: boolean;
}

export type REPLAction =
  | { type: "submitted" }
  | { type: "submit_error"; message: string }
  | { type: "frame"; frame: ServerStreamFrame };

export const initialREPLViewState: REPLViewState = {
  tokenCount: 0,
  isSubmitting: false,
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
      };
    case "submit_error":
      return {
        ...state,
        error: action.message,
        isSubmitting: false,
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
    case "compact_boundary":
      return {
        ...state,
        tokenCount: state.tokenCount + Math.ceil(frame.summary.length / 4),
      };
    case "done":
      return {
        ...state,
        phase: undefined,
        isSubmitting: false,
      };
    case "error":
      return {
        ...state,
        error: frame.message,
        phase: undefined,
        isSubmitting: false,
      };
    case "checkpoint":
    case "diff_preview":
    case "mcp_tool_call":
    case "permission_request":
    case "plan_ready":
    case "thinking":
    case "token":
    case "validate_result":
      return state;
  }
}
