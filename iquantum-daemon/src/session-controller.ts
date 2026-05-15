import { DiffEngine } from "@iquantum/diff-engine";
import type { GitCheckpointStore } from "@iquantum/git";
import { GitManager } from "@iquantum/git";
import type { LLMRouter } from "@iquantum/llm";
import type { PIVEngineOptions, PIVStore } from "@iquantum/piv-engine";
import { PIVEngine } from "@iquantum/piv-engine";
import type { SandboxManager } from "@iquantum/sandbox";
import { loadTestCommand } from "@iquantum/sandbox";
import type { GitCheckpoint, Plan, Session } from "@iquantum/types";
import type { SessionStore } from "./db/stores";

export interface SessionEngine {
  readonly status: PIVEngine["status"];
  readonly currentPlan: PIVEngine["currentPlan"];
  readonly events: PIVEngine["events"];
  startTask(prompt: string): Promise<Plan>;
  approve(planId: string): Promise<void>;
  reject(planId: string, feedback: string): Promise<Plan>;
}

export interface SessionGitManager {
  checkpoint: GitManager["checkpoint"];
  listCheckpoints: GitManager["listCheckpoints"];
  restore: GitManager["restore"];
}

export interface SessionControllerOptions {
  sessionStore: SessionStore;
  pivStore: PIVStore & CurrentPlanStore;
  gitCheckpointStore: GitCheckpointStore;
  sandbox: Pick<
    SandboxManager,
    "createSandbox" | "destroySandbox" | "exec" | "syncToHost"
  >;
  llmRouterFactory: () => Pick<LLMRouter, "complete">;
  createEngine?: (options: PIVEngineOptions) => SessionEngine;
  createGitManager?: (repoPath: string) => SessionGitManager;
  maxRetries?: number;
  now?: () => string;
  createId?: () => string;
  loadTestCommand?: (repoPath: string) => Promise<string | undefined>;
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

export class MissingTestCommandError extends Error {
  constructor(readonly repoPath: string) {
    super(`No test command configured for ${repoPath}`);
    this.name = "MissingTestCommandError";
  }
}

export class SessionController {
  readonly #sessionStore: SessionStore;
  readonly #pivStore: SessionControllerOptions["pivStore"];
  readonly #sandbox: SessionControllerOptions["sandbox"];
  readonly #llmRouterFactory: SessionControllerOptions["llmRouterFactory"];
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

  async createSession(repoPath: string): Promise<Session> {
    const testCommand = await this.#loadTestCommand(repoPath);

    if (!testCommand) {
      throw new MissingTestCommandError(repoPath);
    }

    const sessionId = this.#createId();
    const sandboxInfo = await this.#sandbox.createSandbox(sessionId, repoPath);
    const createdAt = this.#now();
    const session: Session = {
      id: sessionId,
      status: "idle",
      repoPath,
      containerId: sandboxInfo.containerName,
      volumeId: sandboxInfo.volumeName,
      config: { testCommand },
      createdAt,
      updatedAt: createdAt,
    };

    try {
      await this.#sessionStore.insert(session);
    } catch (error) {
      await this.#sandbox.destroySandbox(sessionId);
      throw error;
    }

    const gitManager = this.#createGitManager(repoPath);
    const engine = this.#createEngine({
      sessionId,
      repoPath,
      testCommand,
      store: this.#pivStore,
      llmRouter: this.#llmRouterFactory(),
      diffEngine: new DiffEngine(this.#sandbox),
      sandbox: this.#sandbox,
      gitManager,
      ...(this.#maxRetries === undefined
        ? {}
        : { maxRetries: this.#maxRetries }),
    });

    this.#liveSessions.set(sessionId, { engine, gitManager, session });
    return session;
  }

  async getSession(sessionId: string): Promise<Session> {
    const session = await this.#sessionStore.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    return session;
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.getSession(sessionId);
    await this.#sandbox.destroySandbox(sessionId);
    await this.#sessionStore.delete(sessionId);
    this.#liveSessions.delete(sessionId);
  }

  async startTask(sessionId: string, prompt: string): Promise<Plan> {
    return this.#requireLiveSession(sessionId).engine.startTask(prompt);
  }

  async approve(sessionId: string, planId?: string): Promise<void> {
    const liveSession = this.#requireLiveSession(sessionId);
    const targetPlanId =
      planId ?? (await this.currentPlan(sessionId))?.id;

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
    const targetPlanId =
      planId ?? (await this.currentPlan(sessionId))?.id;

    if (!targetPlanId) {
      throw new Error(`Session ${sessionId} has no pending plan`);
    }

    return liveSession.engine.reject(targetPlanId, feedback);
  }

  async currentPlan(sessionId: string): Promise<Plan | null> {
    await this.getSession(sessionId);
    return this.#pivStore.getCurrentPlan(sessionId);
  }

  async listCheckpoints(sessionId: string): Promise<GitCheckpoint[]> {
    await this.getSession(sessionId);
    return this.#requireLiveSession(sessionId).gitManager.listCheckpoints(
      sessionId,
    );
  }

  async restore(sessionId: string, hash: string): Promise<void> {
    await this.getSession(sessionId);
    await this.#requireLiveSession(sessionId).gitManager.restore(hash);
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
