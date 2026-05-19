import type { SandboxManager } from "@iquantum/sandbox";
import { FileEditTool } from "./tools/file-edit";
import { FileGlobTool } from "./tools/file-glob";
import { FileGrepTool } from "./tools/file-grep";
import { FileReadTool } from "./tools/file-read";
import { FileWriteTool } from "./tools/file-write";

export { PathTraversalError, sanitizeSandboxPath } from "./sanitize";
export { FileEditTool } from "./tools/file-edit";
export { FileGlobTool } from "./tools/file-glob";
export { FileGrepTool } from "./tools/file-grep";
export { FileReadTool } from "./tools/file-read";
export { FileWriteTool } from "./tools/file-write";

export interface FileTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly mutates?: boolean;
  execute(
    input: unknown,
    sandbox: Pick<SandboxManager, "exec">,
    sessionId: string,
  ): Promise<string>;
}

export class SandboxFileTools {
  readonly #tools: FileTool[];

  constructor(maxBytes: number) {
    const read = new FileReadTool();
    const write = new FileWriteTool(maxBytes);
    this.#tools = [
      read,
      new FileEditTool(read, write),
      write,
      new FileGlobTool(),
      new FileGrepTool(),
    ];
  }

  getAll(): FileTool[] {
    return [...this.#tools];
  }
}
