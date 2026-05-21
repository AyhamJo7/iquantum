export type Phase =
  | "requesting"
  | "thinking"
  | "planning"
  | "implementing"
  | "validating";

export interface ApprovalRequestPayload {
  id: string;
  sessionId: string;
  planId: string;
  planContent: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "rejected";
  feedback: string | null;
}

export interface AgentSpawnedFrame {
  type: "agent_spawned";
  sessionId: string;
  name: string;
  colorIndex: number;
  coordinatorSessionId: string;
}

export interface AgentStatusFrame {
  type: "agent_status";
  sessionId: string;
  name: string;
  status: "running" | "done" | "failed" | "killed";
  phase?: Phase;
  turnIndex?: number;
  maxTurns?: number;
}

export interface AgentMessageFrame {
  type: "agent_message";
  sessionId: string;
  name: string;
  content: string;
}

export interface AgentDoneFrame {
  type: "agent_done";
  sessionId: string;
  name: string;
  summary: string;
}

export interface AgentFailedFrame {
  type: "agent_failed";
  sessionId: string;
  name: string;
  error: string;
}

export interface AgentKilledFrame {
  type: "agent_killed";
  sessionId: string;
  name: string;
  reason: string;
}

export interface ApprovalRequestFrame {
  type: "approval_request";
  request: ApprovalRequestPayload;
}

export interface CompactionFrame {
  type: "compaction";
  savedTokens: number;
  strategy: "snip" | "full";
}

export type ServerStreamFrame =
  | { type: "token"; delta: string }
  | { type: "phase_change"; phase: Phase }
  | { type: "plan_ready"; planId: string }
  | { type: "validate_result"; passed: boolean; attempt: number }
  | { type: "checkpoint"; hash: string; message: string }
  | { type: "error"; message: string }
  | { type: "thinking"; delta: string }
  | { type: "diff_preview"; file: string; patch: string }
  | {
      type: "permission_request";
      requestId: string;
      tool: string;
      input: unknown;
    }
  | { type: "compact_boundary"; summary: string; tokenCount: number }
  | ApprovalRequestFrame
  | CompactionFrame
  | AgentSpawnedFrame
  | AgentStatusFrame
  | AgentMessageFrame
  | AgentDoneFrame
  | AgentFailedFrame
  | AgentKilledFrame
  | { type: "tool_call"; toolName: string; input: unknown; result: string }
  | { type: "mcp_tool_call"; server: string; tool: string; input: unknown }
  | { type: "done" };
