import type { SandboxManager } from "@iquantum/sandbox";

export type DiffLineType = "add" | "context" | "remove";

export interface DiffLine {
  type: DiffLineType;
  content: string;
}

export interface Hunk {
  originalStart: number;
  originalCount: number;
  newStart: number;
  newCount: number;
  section: string;
  lines: DiffLine[];
}

export interface FilePatch {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

export interface ApplyFailure {
  filePath: string;
  hunkIndex: number;
  reason: string;
}

export interface ApplyTextResult {
  content: string;
  mode: "exact" | "fuzzy";
}

export interface DiffApplyOptions {
  fuzzySearchRadius?: number;
  minimumConfidence?: number;
}

export class DiffParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffParseError";
  }
}

export class DiffApplyError extends Error {
  constructor(readonly failures: ApplyFailure[]) {
    super(
      failures
        .map(
          (failure) =>
            `${failure.filePath} hunk ${failure.hunkIndex}: ${failure.reason}`,
        )
        .join("; "),
    );
    this.name = "DiffApplyError";
  }
}

export class DiffEngine {
  readonly #sandbox: Pick<SandboxManager, "exec">;

  constructor(sandbox: Pick<SandboxManager, "exec">) {
    this.#sandbox = sandbox;
  }

  async apply(
    sessionId: string,
    rawDiff: string,
    options: DiffApplyOptions = {},
  ): Promise<void> {
    const patches = parseUnifiedDiff(rawDiff);
    const failures: ApplyFailure[] = [];

    // Failures are collected across files; successful patches are written even
    // when others fail. On a partial failure PIVEngine retries Implement against
    // the partially-patched sandbox state, which is intentional.
    for (const patch of patches) {
      const filePath = patchTargetPath(patch);

      try {
        const original =
          patch.oldPath === "/dev/null"
            ? ""
            : await this.#readFile(sessionId, filePath);
        const result = applyFilePatch(original, patch, options);
        await this.#writeFile(sessionId, filePath, result.content);
      } catch (error) {
        if (error instanceof DiffApplyError) {
          failures.push(...error.failures);
          continue;
        }

        throw error;
      }
    }

    if (failures.length > 0) {
      throw new DiffApplyError(failures);
    }
  }

  async #readFile(sessionId: string, filePath: string): Promise<string> {
    const result = await this.#sandbox.exec(
      sessionId,
      `cat -- ${shellQuote(filePath)}`,
    );
    const { stdout, stderr, exitCode } = await collectExec(result);

    if (exitCode !== 0) {
      throw new Error(`Failed to read ${filePath}: ${stderr.trim()}`);
    }

    return stdout;
  }

  async #writeFile(
    sessionId: string,
    filePath: string,
    content: string,
  ): Promise<void> {
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const result = await this.#sandbox.exec(
      sessionId,
      [
        `mkdir -p -- $(dirname -- ${shellQuote(filePath)})`,
        `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(filePath)}`,
      ].join(" && "),
    );
    const { stderr, exitCode } = await collectExec(result);

    if (exitCode !== 0) {
      throw new Error(`Failed to write ${filePath}: ${stderr.trim()}`);
    }
  }
}

export function parseUnifiedDiff(rawOutput: string): FilePatch[] {
  const text = extractDiffText(rawOutput);
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const patches: FilePatch[] = [];
  let currentPatch: FilePatch | undefined;
  let currentHunk: Hunk | undefined;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      currentPatch = undefined;
      currentHunk = undefined;
      continue;
    }

    if (line.startsWith("--- ")) {
      currentPatch = {
        oldPath: normalizeDiffPath(line.slice(4)),
        newPath: "",
        hunks: [],
      };
      patches.push(currentPatch);
      currentHunk = undefined;
      continue;
    }

    if (line.startsWith("+++ ")) {
      if (!currentPatch) {
        throw new DiffParseError(
          "Encountered new-file header before old-file header",
        );
      }

      currentPatch.newPath = normalizeDiffPath(line.slice(4));
      continue;
    }

    if (line.startsWith("@@")) {
      if (!currentPatch) {
        throw new DiffParseError("Encountered hunk before file headers");
      }

      currentHunk = parseHunkHeader(line);
      currentPatch.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk || line === "\\ No newline at end of file") {
      continue;
    }

    const prefix = line[0];

    if (prefix === " ") {
      currentHunk.lines.push({ type: "context", content: line.slice(1) });
    } else if (prefix === "+") {
      currentHunk.lines.push({ type: "add", content: line.slice(1) });
    } else if (prefix === "-") {
      currentHunk.lines.push({ type: "remove", content: line.slice(1) });
    }
  }

  if (patches.length === 0) {
    throw new DiffParseError("No unified diff found in model output");
  }

  for (const patch of patches) {
    if (!patch.newPath || patch.hunks.length === 0) {
      throw new DiffParseError(`Incomplete patch for ${patch.oldPath}`);
    }
  }

  return patches;
}

export function applyFilePatch(
  original: string,
  patch: FilePatch,
  options: DiffApplyOptions = {},
): ApplyTextResult {
  let lines = splitLines(original);
  let mode: ApplyTextResult["mode"] = "exact";
  let lineOffset = 0;
  const failures: ApplyFailure[] = [];

  patch.hunks.forEach((hunk, index) => {
    const expectedIndex = Math.max(0, hunk.originalStart - 1 + lineOffset);
    const sourceLines = hunkSourceLines(hunk);
    const exactIndex = findExactMatch(lines, sourceLines, expectedIndex);
    let matchIndex = exactIndex;

    if (matchIndex === undefined) {
      const fuzzyMatch = findFuzzyMatch(lines, sourceLines, expectedIndex, {
        minimumConfidence: options.minimumConfidence ?? 0.8,
        radius: options.fuzzySearchRadius ?? 5,
      });

      if (!fuzzyMatch) {
        failures.push({
          filePath: patchTargetPath(patch),
          hunkIndex: index,
          reason: "no exact or confident fuzzy match",
        });
        return;
      }

      matchIndex = fuzzyMatch.index;
      mode = "fuzzy";
    }

    const matchedSourceLines = lines.slice(
      matchIndex,
      matchIndex + sourceLines.length,
    );
    const replacement = hunkReplacementLines(hunk, matchedSourceLines);
    lines = [
      ...lines.slice(0, matchIndex),
      ...replacement,
      ...lines.slice(matchIndex + sourceLines.length),
    ];
    lineOffset += replacement.length - sourceLines.length;
  });

  if (failures.length > 0) {
    throw new DiffApplyError(failures);
  }

  return {
    content: joinLines(lines, original.endsWith("\n")),
    mode,
  };
}

function extractDiffText(rawOutput: string): string {
  const fencedBlocks = [
    ...rawOutput.matchAll(/```(?:diff)?\s*\n([\s\S]*?)```/gi),
  ]
    .map((match) => match[1])
    .filter((block): block is string => block !== undefined);

  if (fencedBlocks.length > 0) {
    return fencedBlocks.join("\n");
  }

  return rawOutput;
}

function parseHunkHeader(header: string): Hunk {
  const match = header.match(
    /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@(?<section>.*)$/,
  );

  if (!match?.groups) {
    throw new DiffParseError(`Invalid hunk header: ${header}`);
  }

  return {
    originalStart: Number(match.groups.oldStart),
    originalCount: Number(match.groups.oldCount ?? 1),
    newStart: Number(match.groups.newStart),
    newCount: Number(match.groups.newCount ?? 1),
    section: (match.groups.section ?? "").trim(),
    lines: [],
  };
}

function normalizeDiffPath(path: string): string {
  const trimmed = path.trim().split("\t", 1)[0] ?? path.trim();

  if (trimmed === "/dev/null") {
    return trimmed;
  }

  return trimmed.replace(/^[ab]\//, "");
}

function patchTargetPath(patch: FilePatch): string {
  return patch.newPath === "/dev/null" ? patch.oldPath : patch.newPath;
}

function hunkSourceLines(hunk: Hunk): string[] {
  return hunk.lines
    .filter((line) => line.type !== "add")
    .map((line) => line.content);
}

function hunkReplacementLines(
  hunk: Hunk,
  matchedSourceLines: string[],
): string[] {
  const replacement: string[] = [];
  let sourceIndex = 0;

  for (const line of hunk.lines) {
    if (line.type === "add") {
      replacement.push(line.content);
      continue;
    }

    const matchedLine = matchedSourceLines[sourceIndex] ?? line.content;

    if (line.type === "context") {
      replacement.push(matchedLine);
    }

    sourceIndex += 1;
  }

  return replacement;
}

function splitLines(content: string): string[] {
  if (content === "") {
    return [];
  }

  const lines = content.split("\n");

  if (content.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function findExactMatch(
  lines: string[],
  sourceLines: string[],
  expectedIndex: number,
): number | undefined {
  if (
    arraysEqual(
      lines.slice(expectedIndex, expectedIndex + sourceLines.length),
      sourceLines,
    )
  ) {
    return expectedIndex;
  }

  return undefined;
}

function findFuzzyMatch(
  lines: string[],
  sourceLines: string[],
  expectedIndex: number,
  options: { radius: number; minimumConfidence: number },
): { index: number; confidence: number } | undefined {
  const start = Math.max(0, expectedIndex - options.radius);
  const end = Math.min(
    lines.length - sourceLines.length,
    expectedIndex + options.radius,
  );
  let bestMatch: { index: number; confidence: number } | undefined;

  for (let index = start; index <= end; index += 1) {
    const candidate = lines.slice(index, index + sourceLines.length);
    const confidence = similarity(sourceLines, candidate);

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = { index, confidence };
    }
  }

  if (!bestMatch || bestMatch.confidence < options.minimumConfidence) {
    return undefined;
  }

  return bestMatch;
}

function similarity(left: string[], right: string[]): number {
  const leftText = left.join("\n");
  const rightText = right.join("\n");
  const longestLength = Math.max(leftText.length, rightText.length);

  if (longestLength === 0) {
    return 1;
  }

  return 1 - levenshteinDistance(leftText, rightText) / longestLength;
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previousDiagonal = previous[rightIndex] ?? 0;
      const substitutionCost =
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + 1,
        diagonal + substitutionCost,
      );
      diagonal = previousDiagonal;
    }
  }

  return previous[right.length] ?? 0;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function collectExec(
  result: Awaited<ReturnType<SandboxManager["exec"]>>,
): Promise<{
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

  return {
    stdout,
    stderr,
    exitCode: await result.exitCode,
  };
}
