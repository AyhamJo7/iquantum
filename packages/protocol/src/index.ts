export type Phase =
  | "requesting"
  | "thinking"
  | "planning"
  | "implementing"
  | "validating";

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
  | { type: "mcp_tool_call"; server: string; tool: string; input: unknown }
  | { type: "done" };
