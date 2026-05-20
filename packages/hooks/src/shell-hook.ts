import { spawn as nodeSpawn } from "node:child_process";
import type { HookEvent } from "@iquantum/types";
import type { Hook, HookResult } from "./index";
import { appendHookLog } from "./log";

export class ShellHook implements Hook {
  constructor(
    readonly name: string,
    readonly filePath: string,
    readonly events: HookEvent["type"][],
    readonly timeoutMs: number,
  ) {}

  async run(event: HookEvent): Promise<HookResult> {
    if (typeof Bun === "undefined") {
      return this.#runWithNodeSpawn(event);
    }

    const proc = Bun.spawn([this.filePath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const input = new TextEncoder().encode(JSON.stringify(event));
    const stdin = proc.stdin as unknown as
      | {
          write(data: Uint8Array): unknown;
          end(): unknown;
        }
      | undefined;
    if (stdin) {
      await stdin.write(input);
      await stdin.end();
    }

    let timedOut = false;
    const timeout = new Promise<HookResult>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        proc.kill();
        resolve({ block: false });
      }, this.timeoutMs);
    });

    const completed = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(async ([stdout, stderr, exitCode]) => {
      if (stderr.trim()) {
        await appendHookLog(`[${this.name}] ${stderr.trim()}`);
      }
      if (exitCode !== 0 && !stdout.trim()) {
        return { block: false };
      }
      return parseHookResult(stdout);
    });

    const result = await Promise.race([completed, timeout]);
    if (timedOut) {
      await appendHookLog(`[${this.name}] timed out after ${this.timeoutMs}ms`);
    }
    return result;
  }

  #runWithNodeSpawn(event: HookEvent): Promise<HookResult> {
    return new Promise((resolve) => {
      const child = nodeSpawn(this.filePath, [], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        child.kill();
        void appendHookLog(
          `[${this.name}] timed out after ${this.timeoutMs}ms`,
        );
        resolve({ block: false });
      }, this.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ block: false });
      });
      child.once("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stderr.trim()) {
          void appendHookLog(`[${this.name}] ${stderr.trim()}`);
        }
        resolve(parseHookResult(stdout));
      });
      child.stdin.end(JSON.stringify(event));
    });
  }
}

function parseHookResult(stdout: string): HookResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { block: false };
  }

  try {
    const parsed = JSON.parse(trimmed) as HookResult;
    return {
      ...(parsed.block === undefined ? {} : { block: Boolean(parsed.block) }),
      ...(typeof parsed.message === "string"
        ? { message: parsed.message }
        : {}),
    };
  } catch {
    return { block: false };
  }
}
