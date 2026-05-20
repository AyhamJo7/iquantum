import type { ExecFileException } from "node:child_process";
import { execFile as nodeExecFile } from "node:child_process";
import type { LLMMessage } from "@iquantum/types";

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export interface ReviewFinding {
  severity: ReviewSeverity;
  title: string;
  file: string;
  line: number | null;
  description: string;
  suggestion: string;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  summary: string;
  durationMs: number;
}

export type ReviewTarget =
  | { type: "staged"; ref?: string; path?: string }
  | { type: "commit"; ref: string; path?: string }
  | { type: "path"; path: string; ref?: string }
  | { type: "pr"; ref: string; path?: string };

export type ReviewEvent =
  | ReviewFinding
  | { type: "done"; summary: string; durationMs: number };

export interface ReviewCompleter {
  complete(
    messages: LLMMessage[],
    options: { maxTokens: number },
  ): AsyncIterable<string>;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number },
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
) => void;

export interface ReviewEngineOptions {
  completer: ReviewCompleter;
  execFile?: ExecFileFn;
  now?: () => number;
}

const REVIEW_TIMEOUT_MS = 30_000;
const REVIEW_MAX_TOKENS = 4096;
const severities = new Set(["critical", "high", "medium", "low"]);
const defaultExecFile: ExecFileFn = (file, args, options, callback) => {
  nodeExecFile(file, args, { ...options, encoding: "utf8" }, callback);
};

export class GhCliNotFoundError extends Error {
  constructor() {
    super("gh CLI is required for PR review mode");
    this.name = "GhCliNotFoundError";
  }
}

export class EmptyDiffError extends Error {
  constructor() {
    super("No changes to review.");
    this.name = "EmptyDiffError";
  }
}

export class ReviewParseError extends Error {
  constructor(readonly raw: string) {
    super("Failed to parse review JSON response");
    this.name = "ReviewParseError";
  }
}

export class ReviewEngine {
  readonly #completer: ReviewCompleter;
  readonly #execFile: ExecFileFn;
  readonly #now: () => number;

  constructor(options: ReviewEngineOptions) {
    this.#completer = options.completer;
    this.#execFile = options.execFile ?? defaultExecFile;
    this.#now = options.now ?? Date.now;
  }

  async *review(
    target: ReviewTarget,
    repoPath: string,
  ): AsyncGenerator<ReviewEvent> {
    const startedAt = this.#now();
    const diff = await this.#resolveDiff(target, repoPath);
    if (!diff.trim()) {
      yield {
        type: "done",
        summary: "No changes to review.",
        durationMs: 0,
      };
      return;
    }

    let raw = "";
    for await (const delta of this.#completer.complete(
      this.#buildReviewPrompt(diff),
      { maxTokens: REVIEW_MAX_TOKENS },
    )) {
      raw += delta;
    }

    const parsed = parseReview(raw);
    for (const finding of parsed.findings) {
      yield finding;
    }
    yield {
      type: "done",
      summary: parsed.summary,
      durationMs: Math.max(0, this.#now() - startedAt),
    };
  }

  async #resolveDiff(target: ReviewTarget, repoPath: string): Promise<string> {
    switch (target.type) {
      case "staged":
        return this.#run("git", ["diff", "--staged"], repoPath);
      case "commit":
        return this.#run(
          "git",
          ["diff", `${target.ref}~1`, target.ref, "--unified=3"],
          repoPath,
        );
      case "path":
        return this.#run(
          "git",
          ["diff", "HEAD", "--unified=3", "--", target.path],
          repoPath,
        );
      case "pr":
        return this.#run("gh", ["pr", "diff", target.ref], repoPath);
    }
  }

  #buildReviewPrompt(diff: string): LLMMessage[] {
    return [
      {
        role: "system",
        content: [
          "You are a senior code reviewer. Review the provided unified diff for correctness, security, reliability, and maintainability issues.",
          "Return ONLY valid JSON. Do not wrap it in markdown.",
          'Schema: {"findings":[{"severity":"critical|high|medium|low","title":"string","file":"string","line":number|null,"description":"string","suggestion":"string"}],"summary":"string"}',
          "Prefer concrete, actionable findings. Use critical for exploitable security bugs, data loss, or production-breaking defects.",
        ].join("\n"),
      },
      {
        role: "user",
        content: `Review this diff:\n\n${diff}`,
      },
    ];
  }

  #run(file: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.#execFile(
        file,
        args,
        { cwd, timeout: REVIEW_TIMEOUT_MS },
        (error, stdout, stderr) => {
          if (error) {
            if (file === "gh" && error.code === "ENOENT") {
              reject(new GhCliNotFoundError());
              return;
            }
            reject(
              new Error(
                `${file} ${args.join(" ")} failed: ${stderr.trim() || error.message}`,
              ),
            );
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}

function parseReview(raw: string): Pick<ReviewResult, "findings" | "summary"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    throw new ReviewParseError(raw);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ReviewParseError(raw);
  }
  const candidate = parsed as { findings?: unknown; summary?: unknown };
  if (
    !Array.isArray(candidate.findings) ||
    typeof candidate.summary !== "string"
  ) {
    throw new ReviewParseError(raw);
  }

  return {
    summary: candidate.summary,
    findings: candidate.findings.map((finding) =>
      validateFinding(finding, raw),
    ),
  };
}

function validateFinding(value: unknown, raw: string): ReviewFinding {
  if (typeof value !== "object" || value === null) {
    throw new ReviewParseError(raw);
  }

  const finding = value as Partial<ReviewFinding>;
  if (
    typeof finding.severity !== "string" ||
    !severities.has(finding.severity) ||
    typeof finding.title !== "string" ||
    typeof finding.file !== "string" ||
    !(
      finding.line === null ||
      (typeof finding.line === "number" && Number.isFinite(finding.line))
    ) ||
    typeof finding.description !== "string" ||
    typeof finding.suggestion !== "string"
  ) {
    throw new ReviewParseError(raw);
  }

  return {
    severity: finding.severity as ReviewSeverity,
    title: finding.title,
    file: finding.file,
    line: finding.line,
    description: finding.description,
    suggestion: finding.suggestion,
  };
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}
