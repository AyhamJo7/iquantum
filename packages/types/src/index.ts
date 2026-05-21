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
  scope: "user" | "org";
  source: "manual" | "auto";
  name: string;
  description: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
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
  | {
      type: "post_sampling";
      sessionId: string;
      message: AssistantMessage;
      turnIndex: number;
    }
  | { type: "checkpoint_created"; commitHash: string; sessionId: string }
  | { type: "task_started"; taskId: string; prompt: string; sessionId: string }
  | { type: "task_completed"; taskId: string; sessionId: string };

export interface HookResult {
  block?: boolean;
  message?: string;
  mutatedMessage?: AssistantMessage;
}

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
  parentSessionId?: string | null;
  agentName?: string | null;
  agentColor?: string | null;
  coordinatorMode?: boolean;
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
  compactionAnchor?: boolean;
  createdAt: string;
}

export interface FileSnapshot {
  id: string;
  sessionId: string;
  turnIndex: number;
  filePath: string;
  contentHash: string;
  content: string;
  savedAt: string;
}

export interface AgentManifest {
  name: string;
  prompt: string;
  inheritMemory: boolean;
  worktree: boolean;
  tools?: string[];
  maxTurns?: number;
}

export interface AgentEntry {
  sessionId: string;
  name: string;
  colorIndex: number;
  coordinatorSessionId: string;
  status: "running" | "done" | "failed" | "killed";
}

export interface WorkerManifest {
  workers: Array<{
    name: string;
    task: string;
    dependsOn?: string[];
    worktree: boolean;
  }>;
}

export type ApprovalMode = "cli" | "webhook" | "slack" | "auto";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  planId: string;
  planContent: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "rejected";
  feedback: string | null;
}

export interface ApprovalDecision {
  approved: boolean;
  feedback: string | null;
}

export interface Skill {
  name: string;
  description: string;
  chatAvailable?: boolean;
}

export interface Hook {
  name: string;
  filePath: string;
  events: HookEvent["type"][];
}

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutates?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  chatUnavailable?: boolean;
}

export type PluginExport =
  | { type: "skill"; skill: Skill }
  | { type: "hook"; hook: Hook }
  | { type: "tool"; tool: BuiltinTool }
  | { type: "command"; command: SlashCommand };

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  exports: PluginExport[];
}

export interface PermissionDenial {
  id: string;
  sessionId: string;
  tool: string;
  input: unknown;
  deniedBy: "user" | "hook" | "rule";
  reason: string | null;
  createdAt: string;
}

export interface AllowRule {
  id: string;
  sessionId: string | null;
  orgId: string | null;
  tool: string;
  inputPattern: string | null;
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
