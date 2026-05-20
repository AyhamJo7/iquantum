import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Memory, MemoryType } from "@iquantum/types";
import { z } from "zod";

const memoryTypeSchema = z.enum(["user", "feedback", "project", "reference"]);

export interface MemoryStoreInterface {
  insert(memory: Memory): Promise<void>;
  get(id: string, userId: string): Promise<Memory | null>;
  listByUser(userId: string, orgId?: string | null): Promise<Memory[]>;
  update(
    id: string,
    userId: string,
    updates: Partial<
      Pick<Memory, "type" | "name" | "description" | "body" | "pinned">
    >,
  ): Promise<Memory | null>;
  upsertByName(memory: Memory): Promise<Memory>;
  delete(id: string, userId: string): Promise<void>;
}

export interface MemoryManagerDeps {
  store: MemoryStoreInterface;
  countTokens: (text: string) => number;
  now?: () => string;
  createId?: () => string;
}

export interface MemoryManagerOptions {
  budgetTokens: number;
  memoriesDir: string;
}

export class MemoryManager {
  readonly store: MemoryStoreInterface;
  readonly #countTokens: (text: string) => number;
  readonly #budgetTokens: number;
  readonly #memoriesDir: string;
  readonly #now: () => string;
  readonly #createId: () => string;

  constructor(deps: MemoryManagerDeps, options: MemoryManagerOptions) {
    this.store = deps.store;
    this.#countTokens = deps.countTokens;
    this.#budgetTokens = options.budgetTokens;
    this.#memoriesDir = options.memoriesDir;
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#createId = deps.createId ?? (() => crypto.randomUUID());
  }

  async buildBlock(
    userId: string,
    orgId: string | null,
  ): Promise<{ text: string; tokenCount: number }> {
    const memories = await this.store.listByUser(userId, orgId);
    const sorted = [...memories].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

    let text = "";
    let tokenCount = 0;

    for (const memory of sorted) {
      const entry = `### ${memory.name}\n${memory.body}\n\n`;
      const entryTokens = this.#countTokens(entry);

      if (!memory.pinned && tokenCount + entryTokens > this.#budgetTokens) {
        break;
      }

      text += entry;
      tokenCount += entryTokens;
    }

    return { text: text.trimEnd(), tokenCount };
  }

  async materialize(userId: string, orgId: string | null): Promise<void> {
    const memories = await this.store.listByUser(userId, orgId);
    const outputPath = join(this.#memoriesDir, "MEMORY.md");
    const content = memories.map(formatMemoryEntry).join("\n\n");

    await mkdir(this.#memoriesDir, { recursive: true });
    await writeFile(outputPath, content ? `${content}\n` : "", "utf8");
  }

  async syncFromFile(
    filePath: string,
    userId: string,
    orgId: string | null,
  ): Promise<number> {
    const content = await readFile(filePath, "utf8").catch((error: unknown) => {
      if ((error as { code?: string }).code === "ENOENT") {
        return "";
      }

      throw error;
    });
    let count = 0;

    for (const parsed of parseMemoryFile(content)) {
      const now = this.#now();
      await this.store.upsertByName({
        id: parsed.id ?? this.#createId(),
        userId,
        orgId,
        type: parsed.type,
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        pinned: parsed.pinned,
        createdAt: now,
        updatedAt: now,
      });
      count += 1;
    }

    return count;
  }

  countTokens(block: string): number {
    return this.#countTokens(block);
  }
}

interface ParsedMemoryEntry {
  id?: string;
  name: string;
  type: MemoryType;
  description: string;
  body: string;
  pinned: boolean;
}

function formatMemoryEntry(memory: Memory): string {
  return [
    "---",
    `id: ${frontmatterValue(memory.id)}`,
    `name: ${frontmatterValue(memory.name)}`,
    `type: ${memory.type}`,
    `description: ${frontmatterValue(memory.description)}`,
    `pinned: ${memory.pinned}`,
    "---",
    memory.body,
  ].join("\n");
}

function frontmatterValue(value: string): string {
  return value.replaceAll("\n", " ").trim();
}

function parseMemoryFile(content: string): ParsedMemoryEntry[] {
  const entries: ParsedMemoryEntry[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    if (lines[i] !== "---") {
      i++;
      continue;
    }
    i++; // consume opening ---

    const fmLines: string[] = [];
    while (i < lines.length && lines[i] !== "---") {
      fmLines.push(lines[i] ?? "");
      i++;
    }
    if (i >= lines.length) break;
    i++; // consume closing ---

    const bodyLines: string[] = [];
    while (i < lines.length) {
      // A bare "---" followed by a frontmatter key starts the next entry
      if (lines[i] === "---" && /^\w+:/.test(lines[i + 1] ?? "")) {
        break;
      }
      bodyLines.push(lines[i] ?? "");
      i++;
    }
    // Strip trailing blank lines accumulated before the next entry
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") {
      bodyLines.pop();
    }

    const parsed = parseMemoryEntry(fmLines.join("\n"), bodyLines.join("\n"));
    if (parsed) entries.push(parsed);
  }

  return entries;
}

function parseMemoryEntry(
  frontmatter: string,
  body: string,
): ParsedMemoryEntry | null {
  const fields = parseFrontmatter(frontmatter);
  const type = memoryTypeSchema.safeParse(fields.type ?? "project");

  if (!fields.name || !type.success) {
    return null;
  }

  return {
    ...(fields.id ? { id: fields.id } : {}),
    name: fields.name,
    type: type.data,
    description: fields.description ?? "",
    body: body.trim(),
    pinned: fields.pinned === "true",
  };
}

function parseFrontmatter(frontmatter: string): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) fields[key] = value;
  }

  return fields;
}
