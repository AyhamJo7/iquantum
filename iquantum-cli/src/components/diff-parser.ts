export type DiffLineType = "add" | "del" | "hunk" | "ctx" | "header";

export interface DiffLine {
  type: DiffLineType;
  content: string;
}

export function parseDiffLines(patch: string): DiffLine[] {
  return patch.split("\n").map((raw): DiffLine => {
    if (raw.startsWith("+++") || raw.startsWith("---")) {
      return { type: "header", content: raw };
    }

    if (raw.startsWith("@@")) {
      return { type: "hunk", content: raw };
    }

    if (raw.startsWith("+")) {
      return { type: "add", content: raw.slice(1) };
    }

    if (raw.startsWith("-")) {
      return { type: "del", content: raw.slice(1) };
    }

    return { type: "ctx", content: raw.startsWith(" ") ? raw.slice(1) : raw };
  });
}
