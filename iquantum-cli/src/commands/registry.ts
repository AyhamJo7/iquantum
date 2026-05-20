import type { IquantumConfig, KeybindingMap } from "@iquantum/config";
import type { Skill, SkillContext } from "@iquantum/skills";
import type { REPLAction } from "@iquantum/ui-core";
import type { DaemonClient } from "../client";
import { runDoctor } from "./doctor";

export interface CommandContext {
  client: DaemonClient;
  registry: CommandRegistry;
  sessionId: string;
  dispatch: (action: REPLAction) => void;
  tokenCount: number;
  modelName: string;
  editorModel: string;
  config?: IquantumConfig;
  keybindings?: KeybindingMap;
  repoPath?: string;
  lastError?: string;
}

export interface LocalCommand {
  name: string;
  description: string;
  chatUnavailable?: boolean;
  run(args: string, ctx: CommandContext): Promise<void> | void;
}

export class CommandRegistry {
  readonly #commands: Map<string, LocalCommand>;
  readonly #skillCommands = new Set<string>();

  constructor(commands: LocalCommand[]) {
    this.#commands = new Map(commands.map((c) => [c.name, c]));
  }

  getCompletions(prefix: string): LocalCommand[] {
    const lower = prefix.toLowerCase();
    return [...this.#commands.values()].filter((c) =>
      c.name.toLowerCase().startsWith(lower),
    );
  }

  get(name: string): LocalCommand | undefined {
    return this.#commands.get(name.toLowerCase());
  }

  getAll(): LocalCommand[] {
    return [...this.#commands.values()];
  }

  registerSkill(skill: Skill): void {
    const command = skillToCommand(skill);
    if (
      this.#commands.has(command.name) &&
      !this.#skillCommands.has(command.name)
    ) {
      return;
    }
    this.#commands.set(command.name, command);
    this.#skillCommands.add(command.name);
  }

  clearSkills(): void {
    for (const name of this.#skillCommands) {
      this.#commands.delete(name);
    }
    this.#skillCommands.clear();
  }

  getSkillCommands(): LocalCommand[] {
    return [...this.#skillCommands]
      .map((name) => this.#commands.get(name))
      .filter((command): command is LocalCommand => command !== undefined);
  }
}

export function skillToCommand(skill: Skill): LocalCommand {
  return {
    name: skill.name.toLowerCase(),
    description: skill.description,
    chatUnavailable: skill.chatAvailable === false,
    async run(args, ctx) {
      const skillCtx: SkillContext = {
        sessionId: ctx.sessionId,
        client: ctx.client,
        args,
        dispatch: ctx.dispatch as (action: unknown) => void,
        config: ctx.config ?? ({} as IquantumConfig),
        ...(ctx.repoPath ? { repoPath: ctx.repoPath } : {}),
        ...(ctx.lastError ? { lastError: ctx.lastError } : {}),
        runDoctor,
      };
      await skill.run(args, skillCtx);
    },
  };
}
