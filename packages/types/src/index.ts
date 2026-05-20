export type EffortLevel = "fast" | "normal" | "thorough";

export const CONTEXT_TOKEN_BUDGET = 200_000;

export interface ContextStats {
  systemPrompt: number;
  memory: number;
  repoMap: number;
  messages: number;
  lastTurnTokens: number;
  budget: number;
  available: number;
}

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface Memory {
  id: string;
  userId: string;
  orgId: string | null;
  type: MemoryType;
  name: string;
  description: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HookRun {
  id: string;
  hookName: string;
  eventType: string;
  sessionId: string | null;
  blocked: boolean;
  durationMs: number;
  createdAt: string;
}

export type HookEvent =
  | { type: "pre_tool_call"; tool: string; input: unknown; sessionId: string }
  | {
      type: "post_tool_call";
      tool: string;
      input: unknown;
      output: string;
      durationMs: number;
    }
  | { type: "pre_apply_diff"; file: string; patch: string; sessionId: string }
  | {
      type: "post_validate";
      passed: boolean;
      stdout: string;
      stderr: string;
      sessionId: string;
    }
  | {
      type: "on_permission_request";
      tool: string;
      input: unknown;
      sessionId: string;
    }
  | { type: "session_created"; sessionId: string; repoPath: string }
  | { type: "session_destroyed"; sessionId: string }
  | {
      type: "plan_generated";
      planId: string;
      content: string;
      sessionId: string;
    }
  | { type: "plan_approved"; planId: string; sessionId: string }
  | {
      type: "plan_rejected";
      planId: string;
      feedback: string;
      sessionId: string;
    }
  | { type: "checkpoint_created"; commitHash: string; sessionId: string }
  | { type: "task_started"; taskId: string; prompt: string; sessionId: string }
  | { type: "task_completed"; taskId: string; sessionId: string };

export type SessionStatus =
  | "idle"
  | "planning"
  | "awaiting_approval"
  | "implementing"
  | "validating"
  | "completed"
  | "error";

export type MessageRole = "user" | "assistant" | "tool_call" | "tool_result";

export type PIVPhase = "plan" | "implement" | "validate";

export type PlanStatus = "pending" | "approved" | "rejected" | "superseded";

export interface Session {
  id: string;
  status: SessionStatus;
  repoPath: string;
  containerId: string;
  volumeId: string;
  config: Record<string, unknown>;
  mode: "piv" | "chat";
  effort: EffortLevel;
  worktreePath: string | null;
  worktreeBranch: string | null;
  startCheckpointHash: string | null;
  userId: string | null;
  orgId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  taskId: string | null;
  role: MessageRole;
  phase: PIVPhase;
  model: string | null;
  content: string;
  hasThinking: boolean;
  tokenCount: number;
  compactionBoundary: boolean;
  createdAt: string;
}

export interface Plan {
  id: string;
  sessionId: string;
  content: string;
  status: PlanStatus;
  feedback: string | null;
  createdAt: string;
  approvedAt: string | null;
}

export interface ValidateRun {
  id: string;
  sessionId: string;
  planId: string;
  attempt: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  createdAt: string;
}

export interface GitCheckpoint {
  id: string;
  sessionId: string;
  validateRunId: string;
  commitHash: string;
  commitMessage: string;
  createdAt: string;
}

export interface RepoMapCache {
  repoPath: string;
  contentHash: string;
  mapJson: string;
  tokenCount: number;
  createdAt: string;
}

export type OrgPlan = "free" | "pro" | "enterprise";
export type UserRole = "owner" | "member";

export interface Organization {
  id: string;
  name: string;
  plan: OrgPlan;
  sandboxQuotaHours: number;
  stripeCustomerId: string | null;
  createdAt: string;
}

export interface User {
  id: string;
  orgId: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export type LLMRole = "user" | "assistant" | "system" | "tool";

export interface LLMContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface LLMMessage {
  role: LLMRole;
  content: string | LLMContentBlock[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type CompletionEvent =
  | { type: "token"; delta: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

export interface LLMProvider {
  complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions,
  ): AsyncIterable<string>;
  completeWithTools?(
    messages: LLMMessage[],
    tools: readonly McpTool[],
    options: LLMCompletionOptions,
  ): AsyncIterable<CompletionEvent>;
  countTokens(messages: LLMMessage[], model: string): Promise<number>;
}

export interface LLMCompletionOptions {
  model: string;
  maxTokens: number;
  temperature?: number;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
}

export interface IMcpClient {
  listTools(): Promise<readonly McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}
