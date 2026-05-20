import type { DaemonClient, ReviewTarget } from "../client";
import { isDaemonNotRunning } from "../client";
import {
  formatReviewFinding,
  formatReviewSummary,
} from "../components/review-card-format";

export interface ReviewCommandOptions {
  repo?: string;
  staged?: boolean;
  commit?: string;
  path?: string;
  pr?: string;
}

export interface Writer {
  write(chunk: string): void;
  writeln(line: string): void;
}

export function reviewTargetFromOptions(
  options: ReviewCommandOptions,
): ReviewTarget {
  const selected = [
    options.staged ? "staged" : undefined,
    options.commit ? "commit" : undefined,
    options.path ? "path" : undefined,
    options.pr ? "pr" : undefined,
  ].filter(Boolean);

  if (selected.length > 1) {
    throw new Error("Choose only one review target.");
  }

  if (options.commit) return { type: "commit", ref: options.commit };
  if (options.path) return { type: "path", path: options.path };
  if (options.pr) return { type: "pr", ref: options.pr };
  return { type: "staged" };
}

export function parseReviewArgs(args: string): ReviewTarget {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { type: "staged" };

  const [kind, value] = parts;
  if (kind === "--staged" || kind === "staged") {
    if (parts.length > 1) throw new Error(reviewUsage());
    return { type: "staged" };
  }
  if (kind === "--commit" || kind === "commit") {
    if (!value || parts.length > 2) throw new Error(reviewUsage());
    return { type: "commit", ref: value };
  }
  if (kind === "--path" || kind === "path") {
    if (!value || parts.length > 2) throw new Error(reviewUsage());
    return { type: "path", path: value };
  }
  if (kind === "--pr" || kind === "pr") {
    if (!value || parts.length > 2) throw new Error(reviewUsage());
    return { type: "pr", ref: value };
  }

  throw new Error(reviewUsage());
}

export async function runReview(
  sessionId: string,
  target: ReviewTarget,
  client: DaemonClient,
  writer: Writer,
): Promise<void> {
  if (!client.reviewSession) {
    throw new Error("Review is not supported by this daemon client.");
  }

  let findingCount = 0;
  for await (const event of client.reviewSession(sessionId, target)) {
    if (!("severity" in event)) {
      writer.writeln(
        formatReviewSummary(findingCount, event.summary, event.durationMs),
      );
      return;
    }

    findingCount += 1;
    writer.writeln(formatReviewFinding(event));
    writer.writeln("");
  }
}

export async function runReviewCommand(
  options: ReviewCommandOptions,
  client: DaemonClient,
  writer: Writer,
): Promise<void> {
  const repoPath = options.repo ?? process.cwd();
  const target = reviewTargetFromOptions(options);
  let sessionId: string | undefined;

  try {
    const session = await client.createSession(repoPath, { mode: "chat" });
    sessionId = session.id;
    writer.writeln(`Reviewing ${reviewTargetLabel(target)}...`);
    await runReview(session.id, target, client, writer);
  } catch (error) {
    if (isDaemonNotRunning(error)) {
      writer.writeln(
        "daemon is not running — start it first with: iq daemon start",
      );
      return;
    }
    throw error;
  } finally {
    if (sessionId) {
      await client.destroySession(sessionId).catch(() => undefined);
    }
  }
}

export function reviewTargetLabel(target: ReviewTarget): string {
  switch (target.type) {
    case "staged":
      return "staged changes";
    case "commit":
      return `commit ${target.ref}`;
    case "path":
      return target.path;
    case "pr":
      return `PR ${target.ref}`;
  }
}

function reviewUsage(): string {
  return "Usage: /review [staged|commit <ref>|path <path>|pr <number-or-url>]";
}
