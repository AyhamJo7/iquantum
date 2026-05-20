import type { HookEvent, HookRun } from "@iquantum/types";
import type { Hook, HookResult, HookRunStore } from "./index";
import { appendHookLog } from "./log";

export class HookRunner {
  #hooks: Hook[];
  readonly #store: HookRunStore;
  readonly #now: () => string;

  constructor(hooks: Hook[], store: HookRunStore, now: () => string) {
    this.#hooks = hooks;
    this.#store = store;
    this.#now = now;
  }

  list(): Array<{
    name: string;
    events: HookEvent["type"][];
    filePath: string;
  }> {
    return this.#hooks.map((hook) => ({
      name: hook.name,
      events: hook.events,
      filePath: hook.filePath,
    }));
  }

  updateHooks(hooks: Hook[]): void {
    this.#hooks = hooks;
  }

  async fire(event: HookEvent): Promise<void> {
    const matchingHooks = this.#matching(event);
    await Promise.allSettled(
      matchingHooks.map((hook) => this.#run(hook, event)),
    );
  }

  async gate(
    event: HookEvent,
  ): Promise<{ allowed: boolean; message?: string }> {
    for (const hook of this.#matching(event)) {
      const result = await this.#run(hook, event);
      if (result.block) {
        return {
          allowed: false,
          ...(result.message ? { message: result.message } : {}),
        };
      }
    }

    return { allowed: true };
  }

  #matching(event: HookEvent): Hook[] {
    return this.#hooks.filter((hook) => hook.events.includes(event.type));
  }

  async #run(hook: Hook, event: HookEvent): Promise<HookResult> {
    const start = Date.now();
    let result: HookResult = { block: false };

    try {
      result = await hook.run(event);
      return result;
    } catch (error) {
      await appendHookLog(
        `[${hook.name}] ${error instanceof Error ? error.message : String(error)}`,
      );
      return { block: false };
    } finally {
      await this.#record(hook, event, result, Date.now() - start);
    }
  }

  async #record(
    hook: Hook,
    event: HookEvent,
    result: HookResult,
    durationMs: number,
  ): Promise<void> {
    const run: HookRun = {
      id: crypto.randomUUID(),
      hookName: hook.name,
      eventType: event.type,
      sessionId: sessionIdFromEvent(event),
      blocked: result.block === true,
      durationMs,
      createdAt: this.#now(),
    };

    await this.#store
      .insert(run)
      .catch((error) =>
        appendHookLog(
          `[${hook.name}] failed to record run: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
  }
}

function sessionIdFromEvent(event: HookEvent): string | null {
  return "sessionId" in event && typeof event.sessionId === "string"
    ? event.sessionId
    : null;
}
