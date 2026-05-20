import type { HookEvent, HookRun } from "@iquantum/types";

export type { HookEvent } from "@iquantum/types";
export { InvalidHookError, JsHook } from "./js-hook";
export { HookLoader } from "./loader";
export { HookRunner } from "./runner";
export { ShellHook } from "./shell-hook";

export interface HookResult {
  block?: boolean;
  message?: string;
}

export interface Hook {
  name: string;
  filePath: string;
  events: HookEvent["type"][];
  run(event: HookEvent): Promise<HookResult>;
}

export interface HookRunStore {
  insert(run: HookRun): Promise<void>;
}

export const HOOK_EVENT_TYPES = [
  "pre_tool_call",
  "post_tool_call",
  "pre_apply_diff",
  "post_validate",
  "on_permission_request",
  "session_created",
  "session_destroyed",
  "plan_generated",
  "plan_approved",
  "plan_rejected",
  "checkpoint_created",
  "task_started",
  "task_completed",
] as const satisfies readonly HookEvent["type"][];

export function isHookEventType(value: string): value is HookEvent["type"] {
  return (HOOK_EVENT_TYPES as readonly string[]).includes(value);
}
