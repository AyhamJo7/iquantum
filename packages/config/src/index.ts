import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@iquantum/types";
import { z } from "zod";
import { readConfigFileSync } from "./file-loader";

export { readConfigFileSync } from "./file-loader";
export { writeConfigFile } from "./writer";

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set. Run `iq init` to configure it, or set the environment variable.",
    );
    this.name = "MissingApiKeyError";
  }
}

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
  IQUANTUM_EXEC_TIMEOUT_MS: z.coerce.number().int().min(1).default(120_000),
  IQUANTUM_MCP_SERVERS: z.string().default("[]"),
  IQUANTUM_SANDBOX_IMAGE: z
    .string()
    .min(1)
    .default("ghcr.io/ayhamjo7/iquantum-sandbox:latest"),
});

export interface IquantumConfig {
  anthropicApiKey: string;
  architectModel: string;
  editorModel: string;
  socketPath: string;
  maxRetries: number;
  execTimeoutMs: number;
  mcpServers: McpServerConfig[];
  sandboxImage: string;
}

export interface LoadConfigOptions {
  /** Directory containing config.json (default: ~/.iquantum) */
  configDir?: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): IquantumConfig {
  const configDir = options.configDir ?? join(homedir(), ".iquantum");
  const fileEnv = readConfigFileSync(configDir);
  // env vars win over config file values
  const merged: NodeJS.ProcessEnv = { ...fileEnv, ...env };

  if (!merged.ANTHROPIC_API_KEY) {
    throw new MissingApiKeyError();
  }

  const parsed = envSchema.parse(merged);

  return {
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    architectModel: parsed.IQUANTUM_ARCHITECT_MODEL,
    editorModel: parsed.IQUANTUM_EDITOR_MODEL,
    socketPath: expandHome(parsed.IQUANTUM_SOCKET),
    maxRetries: parsed.MAX_RETRIES,
    execTimeoutMs: parsed.IQUANTUM_EXEC_TIMEOUT_MS,
    mcpServers: parseMcpServers(parsed.IQUANTUM_MCP_SERVERS),
    sandboxImage: parsed.IQUANTUM_SANDBOX_IMAGE,
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
