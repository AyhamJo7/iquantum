import type { IMcpClient, McpServerConfig, McpTool } from "@iquantum/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOOL_CALL_TIMEOUT_MS = 30_000;

export type { McpServerConfig };

export class McpClient implements IMcpClient {
  readonly #config: McpServerConfig;
  readonly #sdkClient: McpSdkClient;
  #connected = false;

  constructor(config: McpServerConfig, sdkClient?: McpSdkClient) {
    this.#config = config;
    this.#sdkClient =
      sdkClient ??
      new Client({ name: "iquantum", version: "0.1.0" }, { capabilities: {} });
  }

  get serverName(): string {
    return this.#config.name;
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    const transport = new StdioClientTransport({
      command: this.#config.command,
      args: this.#config.args ?? [],
      ...(this.#config.env ? { env: this.#config.env } : {}),
    });
    await this.#sdkClient.connect(transport);
    this.#connected = true;
  }

  async listTools(): Promise<readonly McpTool[]> {
    await this.connect();
    const result = await this.#sdkClient.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.connect();
    const result = await withTimeout(
      this.#sdkClient.callTool({ name, arguments: args }),
      TOOL_CALL_TIMEOUT_MS,
      `MCP tool "${name}" timed out after ${TOOL_CALL_TIMEOUT_MS}ms`,
    );
    const content = result.content ?? result.toolResult;
    if (Array.isArray(content)) {
      return content
        .map((c: unknown) =>
          typeof c === "object" &&
          c !== null &&
          "text" in c &&
          typeof (c as { text: unknown }).text === "string"
            ? (c as { text: string }).text
            : "",
        )
        .filter(Boolean)
        .join("\n");
    }
    return typeof content === "string" ? content : JSON.stringify(content);
  }

  async close(): Promise<void> {
    if (!this.#connected) return;
    await this.#sdkClient.close();
    this.#connected = false;
  }
}

export class McpRegistry implements IMcpClient {
  readonly #clients: McpClient[];

  constructor(clients: McpClient[]) {
    this.#clients = clients;
  }

  async listTools(): Promise<readonly McpTool[]> {
    const results: McpTool[] = [];
    for (const client of this.#clients) {
      try {
        for (const tool of await client.listTools()) {
          results.push({ ...tool, name: `${client.serverName}__${tool.name}` });
        }
      } catch {
        // server unavailable — skip silently
      }
    }
    return results;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const sepIdx = name.indexOf("__");
    if (sepIdx === -1) throw new Error(`Invalid tool name format: ${name}`);
    const serverName = name.slice(0, sepIdx);
    const toolName = name.slice(sepIdx + 2);
    const client = this.#clients.find((c) => c.serverName === serverName);
    if (!client) throw new Error(`MCP server "${serverName}" not found`);
    return client.callTool(toolName, args);
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.#clients.map((c) => c.close()));
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// Minimal interface for the MCP SDK Client that McpClient depends on —
// narrow enough to be injectable in tests.
export interface McpSdkClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string | undefined;
      inputSchema: unknown;
    }>;
  }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
