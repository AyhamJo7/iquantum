import { resolve } from "node:path";
import { DiffEngine } from "@iquantum/diff-engine";
import { SandboxFileTools } from "@iquantum/file-tools";
import type { GitCheckpointPage, GitCheckpointStore } from "@iquantum/git";
import { GitManager } from "@iquantum/git";
import type { HookRunner } from "@iquantum/hooks";
import type {
  PIVEngineOptions,
  PIVLLMRouter,
  PIVStore,
} from "@iquantum/piv-engine";
import { PIVEngine } from "@iquantum/piv-engine";
import type { SandboxManager } from "@iquantum/sandbox";
import { loadTestCommand } from "@iquantum/sandbox";
import type { EffortLevel, Plan, Session } from "@iquantum/types";
import { CONTEXT_TOKEN_BUDGET } from "@iquantum/types";
import type { WebToolExecutor } from "@iquantum/web-tools";
import type { ContextStats, SessionStore } from "./db/stores";
import type { RateLimiter } from "./rate-limit";

const GIT_REF_RE = /^[a-zA-Z0-9._/~^:-]{1,200}$/;

export interface SessionEngine {
  readonly status: PIVEngine["status"];
  readonly currentPlan: PIVEngine["currentPlan"];
  readonly events: PIVEngine["events"];
  startTask(prompt: string, options?: { memoryBlock?: string }): Promise<Plan>;
  approve(planId: string): Promise<void>;
  reject(planId: string, feedback: string): Promise<Plan>;
  setEffort(effort: EffortLevel): void;
}

export interface SessionGitManager {
  checkpoint: GitManager["checkpoint"];
  listCheckpoints: GitManager["listCheckpoints"];
  restore: GitManager["restore"];
  currentHead?(): Promise<string | null>;
  createWorktree?(
    sessionId: string,
  ): Promise<{ worktreePath: string; branch: string }>;
  removeWorktree?(worktreePath: string, branch?: string): Promise<void>;
}

export interface SessionControllerOptions {
  sessionStore: SessionStore;
  pivStore: PIVStore & CurrentPlanStore;
  gitCheckpointStore: GitCheckpointStore;
  sandbox: Pick<
    SandboxManager,
    "createSandbox" | "destroySandbox" | "exec" | "syncToHost"
  >;
  llmRouterFactory: () => PIVLLMRouter;
  permissionGate?: PIVEngineOptions["permissionGate"];
  hookRunner?: HookRunner;
  compactionService?: PIVEngineOptions["compactionService"];
  snapshotStore?: PIVEngineOptions["snapshotStore"] & {
    evict(sessionId: string, keepTurns: number): Promise<void>;
  };
  snapshotKeepTurns?: number;
  conversations?: { clearSession(sessionId: string): void };
  createEngine?: (options: PIVEngineOptions) => SessionEngine;
  createGitManager?: (repoPath: string) => SessionGitManager;
  fileToolMaxBytes?: number;
  webTools?: WebToolExecutor;
  webSearchRateLimiter?: RateLimiter;
  memoryManager?: {
    buildBlock(
      userId: string,
      orgId: string | null,
    ): Promise<{ text: string; tokenCount: number }>;
  };
  memoryUserId?: string;
  maxRetries?: number;
  now?: () => string;
  createId?: () => string;
  loadTestCommand?: (repoPath: string) => Promise<string | undefined>;
}

export interface CreateSessionOptions {
  requireApproval?: boolean;
  autoApprove?: boolean;
  mode?: "piv" | "chat";
  effort?: import("@iquantum/types").EffortLevel;
  extraRepoPaths?: string[];
  worktree?: boolean;
}

export interface SessionContext {
  userId: string;
  orgId: string;
}

export interface CurrentPlanStore {
  getCurrentPlan(sessionId: string): Promise<Plan | null>;
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Unknown session ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionNotLiveError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is not live in this daemon process`);
    this.name = "SessionNotLiveError";
  }
}

export class OverlappingRepoError extends Error {
  constructor(readonly repoPath: string) {
    super(
      `Worktree mode cannot include the primary repo as an extra repo: ${repoPath}`,
    );
    this.name = "OverlappingRepoError";
  }
}

export class SessionController {
  readonly #sessionStore: SessionStore;
  readonly #pivStore: SessionControllerOptions["pivStore"];
  readonly #sandbox: SessionControllerOptions["sandbox"];
  readonly #llmRouterFactory: SessionControllerOptions["llmRouterFactory"];
  readonly #permissionGate: PIVEngineOptions["permissionGate"];
  readonly #hookRunner: HookRunner | undefined;
  readonly #compactionService: PIVEngineOptions["compactionService"];
  readonly #snapshotStore: SessionControllerOptions["snapshotStore"];
  readonly #snapshotKeepTurns: number;
  readonly #conversations: SessionControllerOptions["conversations"];
  readonly #fileToolMaxBytes: number | undefined;
  readonly #webTools: WebToolExecutor | undefined;
  readonly #webSearchRateLimiter: RateLimiter | undefined;
  readonly #memoryManager: SessionControllerOptions["memoryManager"];
  readonly #memoryUserId: string;
  readonly #createEngine: NonNullable<SessionControllerOptions["createEngine"]>;
  readonly #createGitManager: NonNullable<
    SessionControllerOptions["createGitManager"]
  >;
  readonly #maxRetries: number | undefined;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #loadTestCommand: NonNullable<
    SessionControllerOptions["loadTestCommand"]
  >;
  readonly #liveSessions = new Map<string, LiveSession>();

  constructor(options: SessionControllerOptions) {
    this.#sessionStore = options.sessionStore;
    this.#pivStore = options.pivStore;
    this.#sandbox = options.sandbox;
    this.#llmRouterFactory = options.llmRouterFactory;
    this.#permissionGate = options.permissionGate;
    this.#hookRunner = options.hookRunner;
    this.#compactionService = options.compactionService;
    this.#snapshotStore = options.snapshotStore;
    this.#snapshotKeepTurns = options.snapshotKeepTurns ?? 100;
    this.#conversations = options.conversations;
    this.#fileToolMaxBytes = options.fileToolMaxBytes;
    this.#webTools = options.webTools;
    this.#webSearchRateLimiter = options.webSearchRateLimiter;
    this.#memoryManager = options.memoryManager;
    this.#memoryUserId = options.memoryUserId ?? "local";
    this.#createEngine =
      options.createEngine ?? ((engineOptions) => new PIVEngine(engineOptions));
    this.#createGitManager =
      options.createGitManager ??
      ((repoPath) =>
        new GitManager({ repoPath, store: options.gitCheckpointStore }));
    this.#maxRetries = options.maxRetries;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#loadTestCommand = options.loadTestCommand ?? loadTestCommand;
  }

  async createSession(
    repoPath: string,
    options: CreateSessionOptions = {},
    context?: SessionContext,
  ): Promise<Session> {
    const testCommand = (await this.#loadTestCommand(repoPath)) ?? "true";

    const sessionId = this.#createId();
    this.#assertValidWorktreeRequest(repoPath, options);
    const repoGitManager = this.#createGitManager(repoPath);
    const startCheckpointHash = (await repoGitManager.currentHead?.()) ?? null;
    let worktreePath: string | null = null;
    let worktreeBranch: string | null = null;
    let engineRepoPath = repoPath;
    let gitManager = repoGitManager;

    if (options.worktree === true) {
      if (!repoGitManager.createWorktree) {
        throw new Error("Git manager does not support worktrees");
      }
      const worktree = await repoGitManager.createWorktree(sessionId);
      worktreePath = worktree.worktreePath;
      worktreeBranch = worktree.branch;
      engineRepoPath = worktreePath;
      gitManager = this.#createGitManager(worktreePath);
    }

    let sandboxInfo: {
      containerName: string;
      volumeName: string;
    };
    try {
      sandboxInfo = await this.#sandbox.createSandbox(
        sessionId,
        engineRepoPath,
      );
    } catch (error) {
      await this.#removeWorktreeQuietly(
        repoGitManager,
        worktreePath,
        worktreeBranch,
      );
      throw error;
    }
    const createdAt = this.#now();
    const session: Session = {
      id: sessionId,
      status: "idle",
      repoPath,
      containerId: sandboxInfo.containerName,
      volumeId: sandboxInfo.volumeName,
      config: {
        testCommand,
        requireApproval: options.requireApproval ?? false,
        autoApprove: options.autoApprove ?? false,
      },
      mode: options.mode ?? "piv",
      effort: options.effort ?? "normal",
      worktreePath,
      worktreeBranch,
      startCheckpointHash,
      userId: context?.userId ?? null,
      orgId: context?.orgId ?? null,
      createdAt,
      updatedAt: createdAt,
    };

    try {
      await this.#sessionStore.insert(session);
    } catch (error) {
      await this.#removeWorktreeQuietly(
        repoGitManager,
        worktreePath,
        worktreeBranch,
      );
      await this.#sandbox.destroySandbox(sessionId);
      throw error;
    }

    const engine = this.#createEngine({
      sessionId,
      ...(context?.userId ? { userId: context.userId } : {}),
      repoPath: engineRepoPath,
      ...(options.extraRepoPaths?.length
        ? { extraRepoPaths: options.extraRepoPaths }
        : {}),
      testCommand,
      effort: session.effort,
      store: this.#pivStore,
      llmRouter: this.#llmRouterFactory(),
      diffEngine: new DiffEngine(this.#sandbox),
      sandbox: this.#sandbox,
      gitManager,
      ...(this.#fileToolMaxBytes === undefined
        ? {}
        : { fileTools: new SandboxFileTools(this.#fileToolMaxBytes) }),
      ...(this.#webTools === undefined ? {} : { webTools: this.#webTools }),
      ...(this.#webSearchRateLimiter === undefined
        ? {}
        : { webToolRateLimiter: this.#webSearchRateLimiter }),
      ...(this.#permissionGate === undefined
        ? {}
        : { permissionGate: this.#permissionGate }),
      ...(this.#hookRunner === undefined
        ? {}
        : { hookRunner: this.#hookRunner }),
      ...(this.#compactionService === undefined
        ? {}
        : { compactionService: this.#compactionService }),
      ...(this.#snapshotStore === undefined
        ? {}
        : { snapshotStore: this.#snapshotStore }),
      requireApproval: options.requireApproval ?? false,
      autoApprove: options.autoApprove ?? false,
      ...(this.#maxRetries === undefined
        ? {}
        : { maxRetries: this.#maxRetries }),
    });

    this.#liveSessions.set(sessionId, { engine, gitManager, session });
    await this.#hookRunner?.fire({
      type: "session_created",
      sessionId,
      repoPath,
    });
    return session;
  }

  async getSession(sessionId: string, orgId?: string): Promise<Session> {
    const session = await this.#sessionStore.get(sessionId, orgId);

    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    return session;
  }

  async listSessions(orgId: string): Promise<Session[]> {
    return this.#sessionStore.listByOrg(orgId);
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    await this.#hookRunner?.fire({ type: "session_destroyed", sessionId });
    await this.#removeWorktreeQuietly(
      this.#createGitManager(session.repoPath),
      session.worktreePath,
      session.worktreeBranch,
    );
    await this.#sandbox.destroySandbox(sessionId);
    await this.#snapshotStore?.evict(sessionId, this.#snapshotKeepTurns);
    await this.#sessionStore.delete(sessionId);
    this.#conversations?.clearSession(sessionId);
    this.#liveSessions.delete(sessionId);
  }

  async #removeWorktreeQuietly(
    gitManager: SessionGitManager,
    worktreePath: string | null,
    branch: string | null,
  ): Promise<void> {
    if (worktreePath === null || !gitManager.removeWorktree) {
      return;
    }

    await gitManager
      .removeWorktree(worktreePath, branch ?? undefined)
      .catch(() => undefined);
  }

  async startTask(sessionId: string, prompt: string): Promise<Plan> {
    const liveSession = this.#requireLiveSession(sessionId);
    const { session } = liveSession;
    const memory = await this.#memoryManager?.buildBlock(
      session.userId ?? this.#memoryUserId,
      session.orgId ?? null,
    );
    return liveSession.engine.startTask(prompt, {
      ...(memory?.text ? { memoryBlock: memory.text } : {}),
    });
  }

  #assertValidWorktreeRequest(
    repoPath: string,
    options: CreateSessionOptions,
  ): void {
    if (options.worktree !== true) {
      return;
    }

    const normalizedRepoPath = resolve(repoPath);
    if (
      options.extraRepoPaths?.some(
        (extraRepoPath) => resolve(extraRepoPath) === normalizedRepoPath,
      )
    ) {
      throw new OverlappingRepoError(repoPath);
    }
  }

  async approve(sessionId: string, planId?: string): Promise<void> {
    const liveSession = this.#requireLiveSession(sessionId);
    const targetPlanId = planId ?? (await this.currentPlan(sessionId))?.id;

    if (!targetPlanId) {
      throw new Error(`Session ${sessionId} has no pending plan`);
    }

    await liveSession.engine.approve(targetPlanId);
  }

  async reject(
    sessionId: string,
    feedback: string,
    planId?: string,
  ): Promise<Plan> {
    const liveSession = this.#requireLiveSession(sessionId);
    const targetPlanId = planId ?? (await this.currentPlan(sessionId))?.id;

    if (!targetPlanId) {
      throw new Error(`Session ${sessionId} has no pending plan`);
    }

    return liveSession.engine.reject(targetPlanId, feedback);
  }

  async currentPlan(sessionId: string): Promise<Plan | null> {
    await this.getSession(sessionId);
    return this.#pivStore.getCurrentPlan(sessionId);
  }

  async listCheckpoints(
    sessionId: string,
    options: { before?: string; limit: number } = { limit: 50 },
  ): Promise<GitCheckpointPage> {
    await this.getSession(sessionId);
    return this.#requireLiveSession(sessionId).gitManager.listCheckpoints(
      sessionId,
      options,
    );
  }

  async restore(sessionId: string, hash: string): Promise<void> {
    await this.getSession(sessionId);
    await this.#requireLiveSession(sessionId).gitManager.restore(hash);
  }

  async updateConfig(
    sessionId: string,
    config: { effort?: EffortLevel },
  ): Promise<Session> {
    const liveSession = this.#requireLiveSession(sessionId);
    const updated = await this.#sessionStore.update(sessionId, {
      ...(config.effort !== undefined ? { effort: config.effort } : {}),
    });
    if (config.effort !== undefined) {
      liveSession.session.effort = config.effort;
      liveSession.engine.setEffort(config.effort);
    }
    return updated;
  }

  async getContextStats(sessionId: string): Promise<ContextStats> {
    await this.getSession(sessionId);
    if (this.#sessionStore.getContextStats) {
      return this.#sessionStore.getContextStats(sessionId);
    }
    return {
      systemPrompt: 0,
      memory: 0,
      repoMap: 0,
      messages: 0,
      lastTurnTokens: 0,
      budget: CONTEXT_TOKEN_BUDGET,
      available: CONTEXT_TOKEN_BUDGET,
    };
  }

  async getDiff(
    sessionId: string,
    from?: string,
    to?: string,
  ): Promise<string> {
    if (from !== undefined && !GIT_REF_RE.test(from)) {
      throw new Error(`Invalid git ref: ${from}`);
    }
    if (to !== undefined && !GIT_REF_RE.test(to)) {
      throw new Error(`Invalid git ref: ${to}`);
    }
    await this.getSession(sessionId);
    const command =
      from && to
        ? `git diff ${from} ${to} --unified=3`
        : from
          ? `git diff ${from} --unified=3`
          : "git diff HEAD --unified=3";

    const result = await this.#sandbox.exec(sessionId, command);
    let stdout = "";
    let stderr = "";
    for await (const chunk of result.output) {
      if (chunk.stream === "stdout") {
        stdout += chunk.data;
      } else {
        stderr += chunk.data;
      }
    }
    const exitCode = await result.exitCode;
    if (exitCode !== 0 && !stdout) {
      throw new Error(
        `git diff failed (exit ${exitCode}): ${stderr.trim() || "no output"}`,
      );
    }

    return stdout;
  }

  getEngine(sessionId: string): SessionEngine {
    return this.#requireLiveSession(sessionId).engine;
  }

  #requireLiveSession(sessionId: string): LiveSession {
    const liveSession = this.#liveSessions.get(sessionId);

    if (!liveSession) {
      throw new SessionNotLiveError(sessionId);
    }

    return liveSession;
  }
}

interface LiveSession {
  engine: SessionEngine;
  gitManager: SessionGitManager;
  session: Session;
}
