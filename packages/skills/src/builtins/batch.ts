import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Skill } from "../index";

export const batchSkill: Skill = {
  name: "batch",
  description: "Run one prompt for every file matched by a glob",
  chatAvailable: false,
  async run(args, ctx) {
    const parsed = parseBatchArgs(args);
    if (!parsed) {
      ctx.dispatch({
        type: "system_message",
        text: 'Usage: /batch --files "<glob>" --prompt "<text>"',
        level: "error",
      });
      return;
    }

    const repoPath = ctx.repoPath ?? process.cwd();
    const files = await findMatchingFiles(repoPath, parsed.files);
    if (files.length === 0) {
      ctx.dispatch({
        type: "system_message",
        text: `No files matched ${parsed.files}.`,
        level: "info",
      });
      return;
    }

    for (const file of files) {
      await ctx.client.postMessage(
        ctx.sessionId,
        [parsed.prompt, "", "Context file:", `file_read ${file}`].join("\n"),
      );
    }

    ctx.dispatch({
      type: "system_message",
      text: `Queued ${files.length} batch task${files.length === 1 ? "" : "s"}.`,
      level: "info",
    });
  },
};

function parseBatchArgs(
  args: string,
): { files: string; prompt: string } | null {
  const tokens = tokenize(args);
  const filesIndex = tokens.indexOf("--files");
  const promptIndex = tokens.indexOf("--prompt");
  const files = filesIndex >= 0 ? tokens[filesIndex + 1] : undefined;
  const prompt = promptIndex >= 0 ? tokens[promptIndex + 1] : undefined;
  return files && prompt ? { files, prompt } : null;
}

function tokenize(input: string): string[] {
  return [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

async function findMatchingFiles(
  root: string,
  pattern: string,
): Promise<string[]> {
  const regex = globToRegex(pattern);
  const matches: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      const rel = relative(root, fullPath);
      if (regex.test(rel)) {
        matches.push(rel);
      }
    }
  }

  await walk(root);
  return matches.slice(0, 200);
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}
