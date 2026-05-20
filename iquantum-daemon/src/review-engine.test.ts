import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ExecFileFn,
  GhCliNotFoundError,
  ReviewEngine,
  type ReviewEvent,
  ReviewParseError,
} from "./review-engine";

const fixturePath = join(
  import.meta.dirname,
  "test-fixtures",
  "security-bug.diff",
);

describe("ReviewEngine", () => {
  it("resolves staged diffs with git diff --staged", async () => {
    const calls: unknown[][] = [];
    const engine = new ReviewEngine({
      completer: jsonCompleter({ findings: [], summary: "ok" }),
      execFile: execMock(calls, "diff --git a/a.ts b/a.ts\n"),
      now: fixedClock(),
    });

    await collect(engine.review({ type: "staged" }, "/repo"));

    expect(calls[0]).toEqual([
      "git",
      ["diff", "--staged"],
      { cwd: "/repo", timeout: 30_000 },
    ]);
  });

  it("throws GhCliNotFoundError when gh is missing for PR review", async () => {
    const engine = new ReviewEngine({
      completer: jsonCompleter({ findings: [], summary: "ok" }),
      execFile(file, _args, _options, callback) {
        const error = Object.assign(new Error("not found"), {
          code: file === "gh" ? "ENOENT" : "EUNKNOWN",
        }) as NonNullable<Parameters<Parameters<ExecFileFn>[3]>[0]>;
        callback(error, "", "");
      },
    });

    await expect(
      collect(engine.review({ type: "pr", ref: "42" }, "/repo")),
    ).rejects.toBeInstanceOf(GhCliNotFoundError);
  });

  it("yields parsed findings and done from a JSON review response", async () => {
    const engine = new ReviewEngine({
      completer: jsonCompleter({
        findings: [
          finding("critical", "Hardcoded key"),
          finding("medium", "Missing test"),
        ],
        summary: "Two issues.",
      }),
      execFile: execMock([], "diff --git a/a.ts b/a.ts\n"),
      now: fixedClock(100, 142),
    });

    await expect(
      collect(engine.review({ type: "commit", ref: "HEAD" }, "/repo")),
    ).resolves.toMatchObject([
      { severity: "critical", title: "Hardcoded key" },
      { severity: "medium", title: "Missing test" },
      { type: "done", summary: "Two issues.", durationMs: 42 },
    ]);
  });

  it("throws ReviewParseError on malformed model JSON", async () => {
    const engine = new ReviewEngine({
      completer: textCompleter("not json"),
      execFile: execMock([], "diff --git a/a.ts b/a.ts\n"),
    });

    await expect(
      collect(engine.review({ type: "staged" }, "/repo")),
    ).rejects.toBeInstanceOf(ReviewParseError);
  });

  it("yields done immediately for an empty diff", async () => {
    const engine = new ReviewEngine({
      completer: textCompleter("should not be called"),
      execFile: execMock([], ""),
    });

    await expect(
      collect(engine.review({ type: "staged" }, "/repo")),
    ).resolves.toMatchInlineSnapshot(`
      [
        {
          "durationMs": 0,
          "summary": "No changes to review.",
          "type": "done",
        },
      ]
    `);
  });

  it("reviews the security fixture and surfaces a critical finding", async () => {
    const diff = await readFile(fixturePath, "utf8");
    const engine = new ReviewEngine({
      completer: jsonCompleter({
        findings: [finding("critical", "Hardcoded production API key")],
        summary: "Security issue found.",
      }),
      execFile: execMock([], diff),
    });

    const events = await collect(
      engine.review({ type: "commit", ref: "fixture" }, "/repo"),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "critical",
          title: "Hardcoded production API key",
        }),
      ]),
    );
  });
});

function finding(severity: string, title: string) {
  return {
    severity,
    title,
    file: "src/auth.ts",
    line: 8,
    description: "The diff adds a hardcoded secret.",
    suggestion: "Read secrets from configuration.",
  };
}

function execMock(calls: unknown[][], stdout: string): ExecFileFn {
  return (file, args, options, callback) => {
    calls.push([file, args, options]);
    callback(null, stdout, "");
  };
}

function jsonCompleter(value: unknown) {
  return textCompleter(JSON.stringify(value));
}

function textCompleter(text: string) {
  return {
    async *complete() {
      yield text;
    },
  };
}

async function collect(
  source: AsyncIterable<ReviewEvent>,
): Promise<ReviewEvent[]> {
  const events: ReviewEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function fixedClock(...values: number[]): () => number {
  const queue = [...values];
  return () => queue.shift() ?? 0;
}
