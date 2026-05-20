import type { IquantumConfig } from "@iquantum/config";
import type { Memory, Plan, Session } from "@iquantum/types";

export { builtinSkills } from "./builtins";
export { SkillLoader } from "./loader";

export interface IquantumClient {
  createMemory(
    memory: Pick<Memory, "type" | "name" | "description" | "body" | "pinned">,
  ): Promise<Memory>;
  exportSession(
    sessionId: string,
    options?: { format?: "markdown" | "json" },
  ): Promise<string>;
  postMessage(sessionId: string, content: string): Promise<void>;
  startTask?(sessionId: string, prompt: string): Promise<Plan>;
  getSession?(sessionId: string): Promise<Session>;
}

export interface SkillContext {
  sessionId: string;
  client: IquantumClient;
  args: string;
  dispatch: (action: unknown) => void;
  config: IquantumConfig;
  repoPath?: string;
  lastError?: string;
  runDoctor?: (config: IquantumConfig) => Promise<void>;
}

export interface Skill {
  name: string;
  description: string;
  chatAvailable?: boolean;
  run(args: string, ctx: SkillContext): Promise<void>;
}
