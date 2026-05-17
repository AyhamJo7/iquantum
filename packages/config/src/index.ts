import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@iquantum/types";
import { z } from "zod";
import { readConfigFileSync } from "./file-loader";

export { readConfigFileSync } from "./file-loader";
export { writeConfigFile } from "./writer";

export class MissingApiKeyError extends Error {
  constructor(provider: "anthropic" | "openai" = "anthropic") {
    super(
      provider === "openai"
        ? "No API key is set for the openai provider. Set IQUANTUM_API_KEY or ANTHROPIC_API_KEY."
        : "ANTHROPIC_API_KEY is not set. Run `iq init` to configure it, or set the environment variable.",
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

const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const envSchema = z
  .object({
    ANTHROPIC_API_KEY: optionalNonEmptyString,
    IQUANTUM_PROVIDER: z.enum(["anthropic", "openai"]).default("anthropic"),
    IQUANTUM_BASE_URL: optionalUrl,
    IQUANTUM_API_KEY: optionalNonEmptyString,
    IQUANTUM_ARCHITECT_MODEL: z.string().min(1).default("claude-sonnet-4-6"),
    IQUANTUM_EDITOR_MODEL: z
      .string()
      .min(1)
      .default("claude-haiku-4-5-20251001"),
    IQUANTUM_SOCKET: z.string().min(1).default("~/.iquantum/daemon.sock"),
    MAX_RETRIES: z.coerce.number().int().min(1).default(3),
    IQUANTUM_EXEC_TIMEOUT_MS: z.coerce.number().int().min(1).default(120_000),
    IQUANTUM_MCP_SERVERS: z.string().default("[]"),
    IQUANTUM_SANDBOX_IMAGE: z
      .string()
      .min(1)
      .default("ghcr.io/ayhamjo7/iquantum-sandbox:latest"),
  })
  .superRefine((value, context) => {
    if (value.IQUANTUM_PROVIDER === "openai" && !value.IQUANTUM_BASE_URL) {
      context.addIssue({
        code: "custom",
        message: "IQUANTUM_BASE_URL is required when IQUANTUM_PROVIDER=openai",
        path: ["IQUANTUM_BASE_URL"],
      });
    }
  });

export interface IquantumConfig {
  anthropicApiKey: string | undefined;
  provider: "anthropic" | "openai";
  baseUrl: string | undefined;
  apiKey: string | undefined;
  providerApiKey: string;
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

  const parsed = envSchema.parse(merged);
  const providerApiKey = resolveProviderApiKey(parsed);

  return {
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    provider: parsed.IQUANTUM_PROVIDER,
    baseUrl: parsed.IQUANTUM_BASE_URL,
    apiKey: parsed.IQUANTUM_API_KEY,
    providerApiKey,
    architectModel: parsed.IQUANTUM_ARCHITECT_MODEL,
    editorModel: parsed.IQUANTUM_EDITOR_MODEL,
    socketPath: expandHome(parsed.IQUANTUM_SOCKET),
    maxRetries: parsed.MAX_RETRIES,
    execTimeoutMs: parsed.IQUANTUM_EXEC_TIMEOUT_MS,
    mcpServers: parseMcpServers(parsed.IQUANTUM_MCP_SERVERS),
    sandboxImage: parsed.IQUANTUM_SANDBOX_IMAGE,
  };
}

function resolveProviderApiKey(parsed: z.infer<typeof envSchema>): string {
  if (parsed.IQUANTUM_PROVIDER === "openai") {
    const apiKey = parsed.IQUANTUM_API_KEY ?? parsed.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new MissingApiKeyError("openai");
    }

    return apiKey;
  }

  if (!parsed.ANTHROPIC_API_KEY) {
    throw new MissingApiKeyError("anthropic");
  }

  return parsed.ANTHROPIC_API_KEY;
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
