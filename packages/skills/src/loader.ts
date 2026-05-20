import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Skill } from "./index";

// biome-ignore lint/complexity/noStaticOnlyClass: SkillLoader is a namespace for load/watch without instance state.
export class SkillLoader {
  static async load(dir: string): Promise<Skill[]> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    const skills: Skill[] = [];
    for (const entry of entries.sort()) {
      const ext = extname(entry);
      if (ext !== ".js" && ext !== ".ts") continue;

      const filePath = join(dir, entry);
      try {
        const url = pathToFileURL(filePath);
        url.searchParams.set("t", String(Date.now()));
        const mod = (await import(url.href)) as { default?: unknown };
        const skill = validateSkill(mod.default);
        if (skill) {
          skills.push(skill);
        }
      } catch {
        // Invalid custom skills are ignored so a bad plugin cannot break CLI startup.
      }
    }

    return skills;
  }

  static watch(dir: string, onChange: (skills: Skill[]) => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void SkillLoader.load(dir).then(onChange);
      }, 300);
    };

    const watcher = Bun.file(dir)
      .exists()
      .then((exists) => {
        if (!exists) return null;
        return import("node:fs").then(({ watch }) => watch(dir, reload));
      });

    return () => {
      if (timer) clearTimeout(timer);
      void watcher.then((handle) => handle?.close());
    };
  }
}

function validateSkill(value: unknown): Skill | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Partial<Skill>;
  if (
    typeof candidate.name !== "string" ||
    !candidate.name.trim() ||
    typeof candidate.description !== "string" ||
    !candidate.description.trim() ||
    typeof candidate.run !== "function"
  ) {
    return null;
  }

  return {
    name: candidate.name.toLowerCase(),
    description: candidate.description,
    ...(candidate.chatAvailable === undefined
      ? {}
      : { chatAvailable: Boolean(candidate.chatAvailable) }),
    run: candidate.run,
  };
}
