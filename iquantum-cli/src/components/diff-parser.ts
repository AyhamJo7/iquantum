export type DiffLineType = "add" | "del" | "hunk" | "ctx" | "header";

export interface DiffLine {
  type: DiffLineType;
  content: string;
  lineNo: number | null;
}

export function parseDiffLines(patch: string): DiffLine[] {
  let originalLineNo: number | null = null;

  return patch.split("\n").map((raw): DiffLine => {
    if (raw.startsWith("+++") || raw.startsWith("---")) {
      return { type: "header", content: raw, lineNo: null };
    }

    if (raw.startsWith("@@")) {
      const originalStart = raw.match(/^@@ -(\d+)/)?.[1];
      originalLineNo = originalStart
        ? Number.parseInt(originalStart, 10)
        : null;
      return { type: "hunk", content: raw, lineNo: null };
    }

    if (raw.startsWith("+")) {
      return { type: "add", content: raw.slice(1), lineNo: null };
    }

    if (raw.startsWith("-")) {
      const lineNo = originalLineNo;
      if (originalLineNo !== null) {
        originalLineNo += 1;
      }
      return { type: "del", content: raw.slice(1), lineNo };
    }

    const lineNo = originalLineNo;
    if (originalLineNo !== null) {
      originalLineNo += 1;
    }
    return {
      type: "ctx",
      content: raw.startsWith(" ") ? raw.slice(1) : raw,
      lineNo,
    };
  });
}

export function countDiffChanges(patch: string): {
  addCount: number;
  delCount: number;
} {
  const lines = parseDiffLines(patch);

  return {
    addCount: lines.filter((line) => line.type === "add").length,
    delCount: lines.filter((line) => line.type === "del").length,
  };
}
