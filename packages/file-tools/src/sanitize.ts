import { posix } from "node:path";

const workspacePrefix = "/workspace";

export class PathTraversalError extends Error {
  constructor(readonly raw: string) {
    super(`Path is outside the sandbox workspace: ${raw}`);
    this.name = "PathTraversalError";
  }
}

export function sanitizeSandboxPath(raw: string): string {
  if (typeof raw !== "string") {
    throw new PathTraversalError(String(raw));
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new PathTraversalError(raw);
  }

  if (trimmed === workspacePrefix) {
    return workspacePrefix;
  }

  if (trimmed.startsWith(`${workspacePrefix}/`)) {
    const relativeFromWorkspace = trimmed.slice(workspacePrefix.length + 1);
    return sanitizeRelativePath(raw, relativeFromWorkspace);
  }

  if (posix.isAbsolute(trimmed)) {
    throw new PathTraversalError(raw);
  }

  return sanitizeRelativePath(raw, trimmed);
}

function sanitizeRelativePath(raw: string, relative: string): string {
  const normalized = posix.normalize(relative);

  if (!normalized || normalized === ".") {
    return workspacePrefix;
  }

  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new PathTraversalError(raw);
  }

  return posix.join(workspacePrefix, normalized);
}
