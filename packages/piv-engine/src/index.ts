import { EventEmitter } from "node:events";
import { DiffApplyError, type DiffEngine } from "@iquantum/diff-engine";
import type { GitManager } from "@iquantum/git";
import type { LLMRouter } from "@iquantum/llm";
import {
  type BuildRepoMapOptions,
  buildRepoMap,
  type RepoMapResult,
} from "@iquantum/repo-map";
import type { ExecResult, SandboxManager } from "@iquantum/sandbox";
import type {
  GitCheckpoint,
  LLMMessage,
  Message,
  PIVPhase,
  Plan,
  SessionStatus,
  ValidateRun,
} from "@iquantum/types";

export interface PIVStore {
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  insertMessage(message: Message): Promise<void>;
  listMessagesByTask(sessionId: string, taskId: string): Promise<Message[]>;
  insertPlan(plan: Plan): Promise<void>;
  getPlan(planId: string): Promise<Plan | null>;
  updatePlan(
    planId: string,
    updates: Pick<Plan, "approvedAt" | "feedback" | "status">,
  ): Promise<Plan>;
  insertValidateRun(run: ValidateRun): Promise<void>;
}

export interface PIVEngineOptions {
  sessionId: string;
  repoPath: string;
  testCommand: string;
  store: PIVStore;
  llmRouter: Pick<LLMRouter, "complete">;
  diffEngine: Pick<DiffEngine, "apply">;
  sandbox: Pick<SandboxManager, "exec" | "syncToHost">;
  gitManager: Pick<GitManager, "checkpoint">;
  repoMapBuilder?: (
    repoPath: string,
    options?: BuildRepoMapOptions,
  ) => Promise<RepoMapResult>;
  maxRetries?: number;
  maxPlanTokens?: number;
  maxImplementTokens?: number;
  testTimeoutMs?: number;
  now?: () => string;
  createId?: () => string;
}

export interface PhaseChangeEvent {
  from: SessionStatus;
  to: SessionStatus;
}

export interface TokenEvent {
  phase: "implement" | "plan";
  token: string;
}

export interface PIVEngineEventMap {
  phase_change: [PhaseChangeEvent];
  token: [TokenEvent];
  plan_ready: [Plan];
  validate_result: [ValidateRun];
  checkpoint: [GitCheckpoint];
  error: [Error];
}

export class InvalidTransitionError extends Error {
  constructor(from: SessionStatus, action: string) {
    super(`Cannot ${action} while session is ${from}`);
    this.name = "InvalidTransitionError";
  }
}

export class RetryLimitExceededError extends Error {
  constructor(readonly maxRetries: number) {
    super(`Retry limit exceeded after ${maxRetries} retries`);
    this.name = "RetryLimitExceededError";
  }
}

export class PIVEngine {
  readonly events = new EventEmitter<PIVEngineEventMap>();
  readonly #sessionId: string;
  readonly #repoPath: string;
  readonly #testCommand: string;
  readonly #store: PIVStore;
  readonly #llmRouter: Pick<LLMRouter, "complete">;
  readonly #diffEngine: Pick<DiffEngine, "apply">;
  readonly #sandbox: Pick<SandboxManager, "exec" | "syncToHost">;
  readonly #gitManager: Pick<GitManager, "checkpoint">;
  readonly #repoMapBuilder: NonNullable<PIVEngineOptions["repoMapBuilder"]>;
  readonly #maxRetries: number;
  readonly #maxPlanTokens: number;
  readonly #maxImplementTokens: number;
  readonly #testTimeoutMs: number;
  readonly #now: () => string;
  readonly #createId: () => string;
  #status: SessionStatus = "idle";
  #taskPrompt: string | undefined;
  #repoMap: string | undefined;
  #currentPlan: Plan | undefined;
  #currentTaskId: string | undefined;
  #retryCount = 0;
  #validateAttempt = 0;

  constructor(options: PIVEngineOptions) {
    this.#sessionId = options.sessionId;
    this.#repoPath = options.repoPath;
    this.#testCommand = options.testCommand;
    this.#store = options.store;
    this.#llmRouter = options.llmRouter;
    this.#diffEngine = options.diffEngine;
    this.#sandbox = options.sandbox;
    this.#gitManager = options.gitManager;
    this.#repoMapBuilder = options.repoMapBuilder ?? buildRepoMap;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#maxPlanTokens = options.maxPlanTokens ?? 1200;
    this.#maxImplementTokens = options.maxImplementTokens ?? 2000;
    this.#testTimeoutMs = options.testTimeoutMs ?? 120_000;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    // Node treats an unhandled "error" event as a thrown exception. The engine
    // still rejects the active operation, but it must remain safe when no
    // StreamController is attached yet.
    this.events.on("error", () => undefined);
  }

  get status(): SessionStatus {
    return this.#status;
  }

  get currentPlan(): Plan | undefined {
    return this.#currentPlan;
  }

  async startTask(prompt: string): Promise<Plan> {
    if (this.#status !== "idle") {
      throw new InvalidTransitionError(this.#status, "start a task");
    }

    this.#taskPrompt = prompt;
    return this.#guard(() => this.#plan());
  }

  async approve(planId: string): Promise<void> {
    if (this.#status !== "awaiting_approval") {
      throw new InvalidTransitionError(this.#status, "approve a plan");
    }

    const plan = await this.#requirePendingPlan(planId);
    this.#currentPlan = await this.#store.updatePlan(plan.id, {
      status: "approved",
      feedback: plan.feedback,
      approvedAt: this.#now(),
    });
    await this.#guard(() => this.#runImplementationLoop());
  }

  async reject(planId: string, feedback: string): Promise<Plan> {
    if (this.#status !== "awaiting_approval") {
      throw new InvalidTransitionError(this.#status, "reject a plan");
    }

    const plan = await this.#requirePendingPlan(planId);
    await this.#store.updatePlan(plan.id, {
      status: "rejected",
      feedback,
      approvedAt: plan.approvedAt,
    });
    return this.#guard(async () => {
      await this.#consumeRetry();
      return this.#plan(feedback);
    });
  }

  async #plan(feedback?: string): Promise<Plan> {
    await this.#transition("planning");
    const planId = this.#createId();
    this.#repoMap ??= (await this.#repoMapBuilder(this.#repoPath)).map;

    const content = await this.#complete("plan", this.#planMessages(feedback), {
      maxTokens: this.#maxPlanTokens,
    });
    await this.#writeWorkspaceFile("PLAN.md", content);

    const plan: Plan = {
      id: planId,
      sessionId: this.#sessionId,
      content,
      status: "pending",
      feedback: feedback ?? null,
      createdAt: this.#now(),
      approvedAt: null,
    };

    await this.#store.insertPlan(plan);
    this.#currentTaskId = planId;
    await this.#insertMessage("user", "plan", this.#taskPrompt ?? "");
    await this.#insertMessage("assistant", "plan", content);
    this.#currentPlan = plan;
    await this.#transition("awaiting_approval");
    this.events.emit("plan_ready", plan);
    return plan;
  }

  async #runImplementationLoop(): Promise<void> {
    while (true) {
      const diffApplied = await this.#implement();

      if (!diffApplied) {
        continue;
      }

      const passed = await this.#validate();

      if (passed) {
        return;
      }
    }
  }

  async #implement(): Promise<boolean> {
    await this.#transition("implementing");
    const content = await this.#complete(
      "implement",
      await this.#implementMessages(),
      { maxTokens: this.#maxImplementTokens },
    );
    await this.#insertMessage("assistant", "implement", content);

    try {
      await this.#diffEngine.apply(this.#sessionId, content);
      return true;
    } catch (error) {
      if (!(error instanceof DiffApplyError)) {
        throw await this.#fail(error);
      }

      await this.#insertMessage("tool_result", "implement", error.message);
      await this.#consumeRetry();
      return false;
    }
  }

  async #validate(): Promise<boolean> {
    await this.#transition("validating");
    const timeoutMs = this.#testTimeoutMs;
    const result = await Promise.race([
      this.#sandbox.exec(this.#sessionId, this.#testCommand).then(collectExec),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`test command timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
    this.#validateAttempt += 1;

    const run: ValidateRun = {
      id: this.#createId(),
      sessionId: this.#sessionId,
      planId: this.#approvedPlan().id,
      attempt: this.#validateAttempt,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      passed: result.exitCode === 0,
      createdAt: this.#now(),
    };

    await this.#store.insertValidateRun(run);
    this.events.emit("validate_result", run);

    if (!run.passed) {
      await this.#insertMessage(
        "tool_result",
        "validate",
        formatValidationFailure(run),
      );
      await this.#consumeRetry();
      return false;
    }

    await this.#sandbox.syncToHost(this.#sessionId);
    const checkpoint = await this.#gitManager.checkpoint(
      this.#sessionId,
      `iquantum: ${shortTask(this.#taskPrompt ?? "validated change")}`,
      run.id,
    );
    this.events.emit("checkpoint", checkpoint);
    await this.#transition("completed");
    return true;
  }

  async #complete(
    phase: "implement" | "plan",
    messages: LLMMessage[],
    options: { maxTokens: number },
  ): Promise<string> {
    let content = "";

    for await (const token of this.#llmRouter.complete(
      phase,
      messages,
      options,
    )) {
      content += token;
      this.events.emit("token", { phase, token });
    }

    return content;
  }

  #planMessages(feedback?: string): LLMMessage[] {
    const userContent = [
      `Task:\n${this.#taskPrompt ?? ""}`,
      `Repository map:\n${this.#repoMap ?? ""}`,
      feedback ? `Plan feedback:\n${feedback}` : undefined,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");

    return [
      {
        role: "system",
        content:
          "Write a concise implementation plan. Do not emit code or diffs yet. If the task produces an analysis or text output (e.g. summarize, explain, list), plan to write that output to a new file so it can be delivered as a file change.",
      },
      { role: "user", content: userContent },
    ];
  }

  async #implementMessages(): Promise<LLMMessage[]> {
    const history = await this.#store.listMessagesByTask(
      this.#sessionId,
      this.#approvedPlan().id,
    );
    const conversation = history.map(toLLMMessage);

    return [
      {
        role: "system",
        content:
          "Implement the approved plan. Return ONLY a unified diff (--- a/... +++ b/... format) suitable for patch application. If the task produces text output rather than code changes, write the output to a new file (e.g. SUMMARY.md) and include that file in the diff. Never return prose outside the diff.",
      },
      {
        role: "user",
        content: [
          `Approved plan:\n${this.#approvedPlan().content}`,
          `Repository map:\n${this.#repoMap ?? ""}`,
        ].join("\n\n"),
      },
      ...conversation,
    ];
  }

  async #writeWorkspaceFile(filePath: string, content: string): Promise<void> {
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const result = await collectExec(
      await this.#sandbox.exec(
        this.#sessionId,
        `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(filePath)}`,
      ),
    );

    if (result.exitCode !== 0) {
      throw await this.#fail(
        new Error(`Failed to write ${filePath}: ${result.stderr.trim()}`),
      );
    }
  }

  async #requirePendingPlan(planId: string): Promise<Plan> {
    const plan = await this.#store.getPlan(planId);

    if (
      !plan ||
      plan.id !== this.#currentPlan?.id ||
      plan.status !== "pending"
    ) {
      throw new Error(`Plan ${planId} is not the pending plan`);
    }

    return plan;
  }

  #approvedPlan(): Plan {
    if (!this.#currentPlan || this.#currentPlan.status !== "approved") {
      throw new Error("No approved plan is active");
    }

    return this.#currentPlan;
  }

  // Single shared budget across plan rejections, diff failures, and validation
  // failures — keeps the ceiling simple but means a rejection counts against
  // the same pool as implementation retries.
  async #consumeRetry(): Promise<void> {
    this.#retryCount += 1;

    if (this.#retryCount > this.#maxRetries) {
      throw await this.#fail(new RetryLimitExceededError(this.#maxRetries));
    }
  }

  async #fail(error: unknown): Promise<Error> {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    await this.#transition("error");
    this.events.emit("error", normalized);
    return normalized;
  }

  async #guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (this.#status !== "error") {
        throw await this.#fail(error);
      }

      throw error;
    }
  }

  async #insertMessage(
    role: Message["role"],
    phase: PIVPhase,
    content: string,
  ): Promise<void> {
    await this.#store.insertMessage({
      id: this.#createId(),
      sessionId: this.#sessionId,
      taskId: this.#currentTaskId ?? null,
      role,
      phase,
      model: null,
      content,
      hasThinking: false,
      tokenCount: roughTokenCount(content),
      compactionBoundary: false,
      createdAt: this.#now(),
    });
  }

  async #transition(next: SessionStatus): Promise<void> {
    const previous = this.#status;

    if (!isAllowedTransition(previous, next)) {
      throw new InvalidTransitionError(previous, `transition to ${next}`);
    }

    this.#status = next;
    await this.#store.updateSessionStatus(this.#sessionId, next);
    this.events.emit("phase_change", { from: previous, to: next });
  }
}

export class InMemoryPIVStore implements PIVStore {
  readonly statuses = new Map<string, SessionStatus>();
  readonly messages: Message[] = [];
  readonly plans: Plan[] = [];
  readonly validateRuns: ValidateRun[] = [];

  async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<void> {
    this.statuses.set(sessionId, status);
  }

  async insertMessage(message: Message): Promise<void> {
    this.messages.push(message);
  }

  async listMessagesByTask(
    sessionId: string,
    taskId: string,
  ): Promise<Message[]> {
    return this.messages.filter(
      (message) => message.sessionId === sessionId && message.taskId === taskId,
    );
  }

  async insertPlan(plan: Plan): Promise<void> {
    this.plans.push(plan);
  }

  async getPlan(planId: string): Promise<Plan | null> {
    return this.plans.find((plan) => plan.id === planId) ?? null;
  }

  async updatePlan(
    planId: string,
    updates: Pick<Plan, "approvedAt" | "feedback" | "status">,
  ): Promise<Plan> {
    const plan = await this.getPlan(planId);

    if (!plan) {
      throw new Error(`Unknown plan ${planId}`);
    }

    Object.assign(plan, updates);
    return plan;
  }

  async insertValidateRun(run: ValidateRun): Promise<void> {
    this.validateRuns.push(run);
  }
}

const allowedTransitions: Record<SessionStatus, readonly SessionStatus[]> = {
  idle: ["planning", "error"],
  planning: ["awaiting_approval", "error"],
  awaiting_approval: ["planning", "implementing", "error"],
  implementing: ["implementing", "validating", "error"],
  validating: ["implementing", "completed", "error"],
  completed: [],
  error: [],
};

function isAllowedTransition(from: SessionStatus, to: SessionStatus): boolean {
  return allowedTransitions[from].includes(to);
}

function toLLMMessage(message: Message): LLMMessage {
  switch (message.role) {
    case "user":
    case "assistant":
      return { role: message.role, content: message.content };
    case "tool_call":
    case "tool_result":
      return { role: "tool", content: message.content };
  }
}

async function collectExec(result: ExecResult): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  let stdout = "";
  let stderr = "";

  for await (const chunk of result.output) {
    if (chunk.stream === "stdout") {
      stdout += chunk.data;
    } else {
      stderr += chunk.data;
    }
  }

  return { stdout, stderr, exitCode: await result.exitCode };
}

function formatValidationFailure(run: ValidateRun): string {
  return [
    `Validation failed on attempt ${run.attempt} with exit code ${run.exitCode}.`,
    run.stdout ? `stdout:\n${run.stdout}` : undefined,
    run.stderr ? `stderr:\n${run.stderr}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shortTask(task: string): string {
  return task.replaceAll(/\s+/g, " ").trim().slice(0, 72);
}
