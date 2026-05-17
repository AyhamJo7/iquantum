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

export class MissingCloudConfigError extends Error {
  constructor(readonly keys: string[]) {
    super(`Missing cloud config: ${keys.join(", ")}`);
    this.name = "MissingCloudConfigError";
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

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(32).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const optionalCsv = z.preprocess((value) => {
  if (value === "" || value === undefined) return undefined;
  if (typeof value !== "string") return value;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}, z.array(z.string().min(1)).optional());

const envBoolean = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }
  return value;
}, z.boolean().default(false));

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
    IQUANTUM_TCP_PORT: z.coerce
      .number()
      .int()
      .min(1024)
      .max(65535)
      .default(51820),
    MAX_RETRIES: z.coerce.number().int().min(1).default(3),
    IQUANTUM_EXEC_TIMEOUT_MS: z.coerce.number().int().min(1).default(120_000),
    IQUANTUM_MCP_SERVERS: z.string().default("[]"),
    IQUANTUM_SANDBOX_IMAGE: z
      .string()
      .min(1)
      .default("ghcr.io/ayhamjo7/iquantum-sandbox:latest"),
    IQUANTUM_CLOUD: envBoolean,
    DATABASE_URL: optionalUrl,
    REDIS_URL: optionalUrl,
    JWT_SECRET: optionalSecret,
    STRIPE_SECRET_KEY: optionalNonEmptyString,
    STRIPE_WEBHOOK_SECRET: optionalNonEmptyString,
    AWS_REGION: optionalNonEmptyString,
    AWS_ECS_CLUSTER: optionalNonEmptyString,
    AWS_EFS_FILE_SYSTEM_ID: optionalNonEmptyString,
    AWS_SUBNET_IDS: optionalCsv,
    AWS_SECURITY_GROUP_IDS: optionalCsv,
    AWS_ASSIGN_PUBLIC_IP: envBoolean,
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
  tcpPort: number;
  maxRetries: number;
  execTimeoutMs: number;
  mcpServers: McpServerConfig[];
  sandboxImage: string;
  cloud: boolean;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  jwtSecret: string | undefined;
  stripeSecretKey: string | undefined;
  stripeWebhookSecret: string | undefined;
  awsRegion: string | undefined;
  awsEcsCluster: string | undefined;
  awsEfsFileSystemId: string | undefined;
  awsSubnetIds: string[] | undefined;
  awsSecurityGroupIds: string[] | undefined;
  awsAssignPublicIp: boolean;
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
  validateCloudConfig(parsed);

  return {
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    provider: parsed.IQUANTUM_PROVIDER,
    baseUrl: parsed.IQUANTUM_BASE_URL,
    apiKey: parsed.IQUANTUM_API_KEY,
    providerApiKey,
    architectModel: parsed.IQUANTUM_ARCHITECT_MODEL,
    editorModel: parsed.IQUANTUM_EDITOR_MODEL,
    socketPath: expandHome(parsed.IQUANTUM_SOCKET),
    tcpPort: parsed.IQUANTUM_TCP_PORT,
    maxRetries: parsed.MAX_RETRIES,
    execTimeoutMs: parsed.IQUANTUM_EXEC_TIMEOUT_MS,
    mcpServers: parseMcpServers(parsed.IQUANTUM_MCP_SERVERS),
    sandboxImage: parsed.IQUANTUM_SANDBOX_IMAGE,
    cloud: parsed.IQUANTUM_CLOUD,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    jwtSecret: parsed.JWT_SECRET,
    stripeSecretKey: parsed.STRIPE_SECRET_KEY,
    stripeWebhookSecret: parsed.STRIPE_WEBHOOK_SECRET,
    awsRegion: parsed.AWS_REGION,
    awsEcsCluster: parsed.AWS_ECS_CLUSTER,
    awsEfsFileSystemId: parsed.AWS_EFS_FILE_SYSTEM_ID,
    awsSubnetIds: parsed.AWS_SUBNET_IDS,
    awsSecurityGroupIds: parsed.AWS_SECURITY_GROUP_IDS,
    awsAssignPublicIp: parsed.AWS_ASSIGN_PUBLIC_IP,
  };
}

function validateCloudConfig(parsed: z.infer<typeof envSchema>): void {
  if (!parsed.IQUANTUM_CLOUD) return;

  const required = [
    ["JWT_SECRET", parsed.JWT_SECRET],
    ["DATABASE_URL", parsed.DATABASE_URL],
    ["REDIS_URL", parsed.REDIS_URL],
    ["STRIPE_SECRET_KEY", parsed.STRIPE_SECRET_KEY],
    ["AWS_ECS_CLUSTER", parsed.AWS_ECS_CLUSTER],
    ["AWS_EFS_FILE_SYSTEM_ID", parsed.AWS_EFS_FILE_SYSTEM_ID],
    ["AWS_SUBNET_IDS", parsed.AWS_SUBNET_IDS],
    ["AWS_SECURITY_GROUP_IDS", parsed.AWS_SECURITY_GROUP_IDS],
  ] as const;
  const missing = required.filter(([, value]) => !value).map(([key]) => key);

  if (missing.length > 0) {
    throw new MissingCloudConfigError(missing);
  }
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
