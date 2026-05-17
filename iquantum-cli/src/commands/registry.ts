import type { REPLAction } from "@iquantum/ui-core";
import type { DaemonClient } from "../client";

export interface CommandContext {
  client: DaemonClient;
  registry: CommandRegistry;
  sessionId: string;
  dispatch: (action: REPLAction) => void;
  tokenCount: number;
  modelName: string;
  editorModel: string;
}

export interface LocalCommand {
  name: string;
  description: string;
  chatUnavailable?: boolean;
  run(args: string, ctx: CommandContext): Promise<void> | void;
}

export class CommandRegistry {
  readonly #commands: Map<string, LocalCommand>;

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
}
