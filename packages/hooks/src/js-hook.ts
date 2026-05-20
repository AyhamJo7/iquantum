import { pathToFileURL } from "node:url";
import type { HookEvent } from "@iquantum/types";
import type { Hook, HookResult } from "./index";
import { isHookEventType } from "./index";

export class InvalidHookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHookError";
  }
}

interface JsHookModule {
  name: string;
  events: HookEvent["type"][];
  run(event: HookEvent): Promise<HookResult> | HookResult;
}

export class JsHook implements Hook {
  constructor(
    readonly name: string,
    readonly filePath: string,
    readonly events: HookEvent["type"][],
    readonly timeoutMs: number,
    readonly module: JsHookModule,
  ) {}

  static async load(filePath: string, timeoutMs: number): Promise<JsHook> {
    const url = pathToFileURL(filePath);
    url.searchParams.set("t", String(Date.now()));
    const mod = (await import(url.href)) as { default?: unknown };
    const hook = validateModule(mod.default);
    return new JsHook(hook.name, filePath, hook.events, timeoutMs, hook);
  }

  async run(event: HookEvent): Promise<HookResult> {
    return Promise.race([
      Promise.resolve(this.module.run(event)).then(normalizeResult),
      timeout(this.timeoutMs),
    ]);
  }
}

function validateModule(value: unknown): JsHookModule {
  if (typeof value !== "object" || value === null) {
    throw new InvalidHookError("hook default export must be an object");
  }

  const candidate = value as Partial<JsHookModule>;
  if (typeof candidate.name !== "string" || !candidate.name.trim()) {
    throw new InvalidHookError("hook name is required");
  }
  if (
    !Array.isArray(candidate.events) ||
    candidate.events.some(
      (event) => typeof event !== "string" || !isHookEventType(event),
    )
  ) {
    throw new InvalidHookError("hook events must be valid hook event names");
  }
  if (typeof candidate.run !== "function") {
    throw new InvalidHookError("hook run function is required");
  }

  return {
    name: candidate.name,
    events: candidate.events,
    run: candidate.run,
  };
}

function normalizeResult(result: HookResult | undefined | null): HookResult {
  if (!result) {
    return { block: false };
  }
  return {
    ...(result.block === undefined ? {} : { block: Boolean(result.block) }),
    ...(typeof result.message === "string" ? { message: result.message } : {}),
  };
}

function timeout(ms: number): Promise<HookResult> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ block: false }), ms);
  });
}
