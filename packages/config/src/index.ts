import { homedir } from "node:os";
import { resolve } from "node:path";
import type { McpServerConfig } from "@iquantum/types";
import { z } from "zod";

const mcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const parseMcpServers = (raw: string): McpServerConfig[] => {
  try {
    return z.array(mcpServerSchema).parse(JSON.parse(raw));
  } catch {
    return [];
  }
};

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  IQUANTUM_ARCHITECT_MODEL: z.string().min(1).default("claude-sonnet-4-5"),
  IQUANTUM_EDITOR_MODEL: z.string().min(1).default("claude-haiku-4-5-20251001"),
  IQUANTUM_SOCKET: z.string().min(1).default("~/.iquantum/daemon.sock"),
  MAX_RETRIES: z.coerce.number().int().min(1).default(3),
  IQUANTUM_MCP_SERVERS: z.string().default("[]"),
});

export interface IquantumConfig {
  anthropicApiKey: string;
  architectModel: string;
  editorModel: string;
  socketPath: string;
  maxRetries: number;
  mcpServers: McpServerConfig[];
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): IquantumConfig {
  const parsed = envSchema.parse(env);

  return {
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    architectModel: parsed.IQUANTUM_ARCHITECT_MODEL,
    editorModel: parsed.IQUANTUM_EDITOR_MODEL,
    socketPath: expandHome(parsed.IQUANTUM_SOCKET),
    maxRetries: parsed.MAX_RETRIES,
    mcpServers: parseMcpServers(parsed.IQUANTUM_MCP_SERVERS),
  };
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}
