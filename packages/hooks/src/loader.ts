import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { HookEvent } from "@iquantum/types";
import type { Hook } from "./index";
import { isHookEventType } from "./index";
import { JsHook } from "./js-hook";
import { appendHookLog } from "./log";
import { ShellHook } from "./shell-hook";

// biome-ignore lint/complexity/noStaticOnlyClass: HookLoader is a namespace for load/watch without instance state.
export class HookLoader {
  static async load(dir: string, timeoutMs: number): Promise<Hook[]> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    const hooks: Hook[] = [];
    for (const entry of entries.sort()) {
      const filePath = join(dir, entry);
      const ext = extname(entry);
      try {
        if (ext === ".sh") {
          const events = await readShellEvents(filePath);
          if (events.length > 0) {
            hooks.push(
              new ShellHook(basename(entry, ext), filePath, events, timeoutMs),
            );
          }
        } else if (ext === ".js" || ext === ".ts") {
          hooks.push(await JsHook.load(filePath, timeoutMs));
        }
      } catch (error) {
        await appendHookLog(
          `[loader] skipped ${filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return hooks;
  }

  static watch(
    dir: string,
    timeoutMs: number,
    onChange: (hooks: Hook[]) => void,
  ): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void HookLoader.load(dir, timeoutMs).then(onChange);
      }, 500);
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

async function readShellEvents(filePath: string): Promise<HookEvent["type"][]> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const eventLine = lines[0]?.startsWith("#!") ? lines[1] : lines[0];
  const match = eventLine?.match(/^#\s*events:\s*(.+)$/i);
  if (!match) {
    return ["post_validate"];
  }

  const value = match[1] ?? "";
  return value
    .split(",")
    .map((event) => event.trim())
    .filter(isHookEventType);
}
