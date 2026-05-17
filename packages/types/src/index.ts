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
