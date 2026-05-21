import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadConfig,
  MissingApiKeyError,
  MissingCloudConfigError,
} from "./index";

const validEnv = {
  ANTHROPIC_API_KEY: "test-key",
  IQUANTUM_ARCHITECT_MODEL: "architect",
  IQUANTUM_EDITOR_MODEL: "editor",
  IQUANTUM_SOCKET: "/tmp/iquantum.sock",
  MAX_RETRIES: "3",
  IQUANTUM_EXEC_TIMEOUT_MS: "45000",
};

describe("loadConfig", () => {
  it("parses required environment variables", () => {
    expect(loadConfig(validEnv)).toEqual({
      anthropicApiKey: "test-key",
      provider: "anthropic",
      baseUrl: undefined,
      apiKey: undefined,
      providerApiKey: "test-key",
      architectModel: "architect",
      editorModel: "editor",
      socketPath: "/tmp/iquantum.sock",
      tcpPort: 51820,
      maxRetries: 3,
      execTimeoutMs: 45_000,
      mcpServers: [],
      sandboxImage: "ghcr.io/ayhamjo7/iquantum-sandbox:latest",
      cloud: false,
      databaseUrl: undefined,
      redisUrl: undefined,
      jwtSecret: undefined,
      stripeSecretKey: undefined,
      stripeWebhookSecret: undefined,
      awsRegion: undefined,
      awsEcsCluster: undefined,
      awsEfsFileSystemId: undefined,
      awsSubnetIds: undefined,
      awsSecurityGroupIds: undefined,
      awsAssignPublicIp: false,
      corsOrigins: undefined,
      sentryDsn: undefined,
      memoryTokens: 2000,
      autoMemory: false,
      autoMemoryMax: 5,
      autoMemoryModel: undefined,
      fileTools: true,
      fileToolMaxBytes: 10_485_760,
      webTools: false,
      searchProvider: "brave",
      braveApiKey: undefined,
      tavilyApiKey: undefined,
      hooksDir: expect.stringContaining(".iquantum/hooks"),
      hookTimeoutMs: 5000,
      skillsDir: expect.stringContaining(".iquantum/skills"),
      keybindingsFile: expect.stringContaining(".iquantum/keybindings.json"),
      reviewModel: undefined,
      compactionAutoThreshold: 0.8,
      compactionKeepTurns: 8,
      compactionSummaryTokens: 4000,
      snapshots: true,
      snapshotMaxTurns: 100,
      maxAgents: 4,
      agentMaxTurns: 50,
      memoryRanking: true,
      memoryRankingModel: undefined,
      approvalMode: "cli",
      approvalWebhookUrl: undefined,
      approvalWebhookSecret: undefined,
      approvalTimeoutMs: 1_800_000,
      slackToken: undefined,
      slackChannel: undefined,
      slackApprovalWebhook: undefined,
      sandboxUpstreamProxy: false,
      sandboxCpuShares: 1024,
      sandboxMemoryLimitMb: 2048,
      sandboxNetwork: "none",
    });
  });

  it("throws MissingApiKeyError when API key is absent", () => {
    const noFile = { configDir: "/tmp/iq-test-no-config-dir" };
    expect(() => loadConfig({}, noFile)).toThrow(MissingApiKeyError);
    expect(() => loadConfig({}, noFile)).toThrow(
      "ANTHROPIC_API_KEY is not set",
    );
  });

  it("throws MissingApiKeyError (not a raw ZodError) when key is empty string", () => {
    expect(() => loadConfig({ ...validEnv, ANTHROPIC_API_KEY: "" })).toThrow(
      MissingApiKeyError,
    );
  });

  it("uses release defaults for optional settings", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "test-key" })).toMatchObject({
      provider: "anthropic",
      architectModel: "claude-sonnet-4-6",
      editorModel: "claude-haiku-4-5-20251001",
      maxRetries: 3,
      execTimeoutMs: 120_000,
      sandboxImage: "ghcr.io/ayhamjo7/iquantum-sandbox:latest",
    });
    expect(loadConfig({ ANTHROPIC_API_KEY: "test-key" }).socketPath).toContain(
      ".iquantum/daemon.sock",
    );
  });

  it("parses web tool configuration", () => {
    expect(
      loadConfig({
        ...validEnv,
        IQUANTUM_WEB_TOOLS: "true",
        IQUANTUM_SEARCH_PROVIDER: "tavily",
        BRAVE_API_KEY: "brave-key",
        TAVILY_API_KEY: "tavily-key",
      }),
    ).toMatchObject({
      webTools: true,
      searchProvider: "tavily",
      braveApiKey: "brave-key",
      tavilyApiKey: "tavily-key",
    });
  });

  it("parses phase 0 foundation config overrides", () => {
    expect(
      loadConfig({
        ...validEnv,
        IQUANTUM_COMPACTION_AUTO_THRESHOLD: "0.9",
        IQUANTUM_COMPACTION_KEEP_TURNS: "12",
        IQUANTUM_COMPACTION_SUMMARY_TOKENS: "2048",
        IQUANTUM_SNAPSHOTS: "false",
        IQUANTUM_SNAPSHOT_MAX_TURNS: "77",
        IQUANTUM_MAX_AGENTS: "6",
        IQUANTUM_AGENT_MAX_TURNS: "33",
        IQUANTUM_MEMORY_RANKING: "false",
        IQUANTUM_MEMORY_RANKING_MODEL: "embed-large",
        IQUANTUM_AUTO_MEMORY_MAX: "7",
        IQUANTUM_AUTO_MEMORY_MODEL: "auto-mem",
        IQUANTUM_APPROVAL_MODE: "webhook",
        IQUANTUM_APPROVAL_WEBHOOK_URL: "https://example.com/approve",
        IQUANTUM_APPROVAL_WEBHOOK_SECRET: "secret",
        IQUANTUM_APPROVAL_TIMEOUT_MS: "60000",
        IQUANTUM_SLACK_TOKEN: "xoxb-test",
        IQUANTUM_SLACK_CHANNEL: "alerts",
        IQUANTUM_SLACK_APPROVAL_WEBHOOK: "https://example.com/slack",
        IQUANTUM_SANDBOX_UPSTREAM_PROXY: "true",
        IQUANTUM_SANDBOX_CPU_SHARES: "2048",
        IQUANTUM_SANDBOX_MEMORY_LIMIT_MB: "4096",
        IQUANTUM_SANDBOX_NETWORK: "bridge",
      }),
    ).toMatchObject({
      compactionAutoThreshold: 0.9,
      compactionKeepTurns: 12,
      compactionSummaryTokens: 2048,
      snapshots: false,
      snapshotMaxTurns: 77,
      maxAgents: 6,
      agentMaxTurns: 33,
      memoryRanking: false,
      memoryRankingModel: "embed-large",
      autoMemoryMax: 7,
      autoMemoryModel: "auto-mem",
      approvalMode: "webhook",
      approvalWebhookUrl: "https://example.com/approve",
      approvalWebhookSecret: "secret",
      approvalTimeoutMs: 60_000,
      slackToken: "xoxb-test",
      slackChannel: "alerts",
      slackApprovalWebhook: "https://example.com/slack",
      sandboxUpstreamProxy: true,
      sandboxCpuShares: 2048,
      sandboxMemoryLimitMb: 4096,
      sandboxNetwork: "bridge",
    });
  });

  it("does not require a base URL for the default anthropic provider", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "test-key" })).toMatchObject({
      provider: "anthropic",
      baseUrl: undefined,
    });
  });

  it("accepts openai provider settings and prefers its dedicated API key", () => {
    expect(
      loadConfig(
        {
          IQUANTUM_PROVIDER: "openai",
          IQUANTUM_BASE_URL: "https://api.deepseek.com",
          IQUANTUM_API_KEY: "openai-key",
        },
        { configDir: "/tmp/iq-test-no-config-dir" },
      ),
    ).toMatchObject({
      anthropicApiKey: undefined,
      provider: "openai",
      baseUrl: "https://api.deepseek.com",
      apiKey: "openai-key",
      providerApiKey: "openai-key",
    });
  });

  it("allows the openai provider to fall back to ANTHROPIC_API_KEY", () => {
    expect(
      loadConfig({
        ANTHROPIC_API_KEY: "fallback-key",
        IQUANTUM_PROVIDER: "openai",
        IQUANTUM_BASE_URL: "https://api.deepseek.com",
      }),
    ).toMatchObject({
      provider: "openai",
      anthropicApiKey: "fallback-key",
      apiKey: undefined,
      providerApiKey: "fallback-key",
    });
  });

  it("requires a valid base URL for the openai provider", () => {
    expect(() =>
      loadConfig({
        IQUANTUM_PROVIDER: "openai",
        IQUANTUM_API_KEY: "openai-key",
      }),
    ).toThrow("IQUANTUM_BASE_URL is required");

    expect(() =>
      loadConfig({
        IQUANTUM_PROVIDER: "openai",
        IQUANTUM_API_KEY: "openai-key",
        IQUANTUM_BASE_URL: "not-a-url",
      }),
    ).toThrow();
  });

  it("throws MissingApiKeyError when openai cannot resolve any API key", () => {
    expect(() =>
      loadConfig(
        {
          IQUANTUM_PROVIDER: "openai",
          IQUANTUM_BASE_URL: "https://api.deepseek.com",
        },
        { configDir: "/tmp/iq-test-no-config-dir" },
      ),
    ).toThrow(MissingApiKeyError);
  });

  it("validates required cloud settings", () => {
    expect(() =>
      loadConfig({
        ANTHROPIC_API_KEY: "test-key",
        IQUANTUM_CLOUD: "true",
      }),
    ).toThrow(MissingCloudConfigError);

    expect(
      loadConfig({
        ANTHROPIC_API_KEY: "test-key",
        IQUANTUM_CLOUD: "true",
        DATABASE_URL: "postgresql://localhost/db",
        REDIS_URL: "redis://localhost:6379",
        JWT_SECRET: "x".repeat(32),
        STRIPE_SECRET_KEY: "sk_test",
        AWS_ECS_CLUSTER: "cluster",
        AWS_EFS_FILE_SYSTEM_ID: "fs-123",
        AWS_SUBNET_IDS: "subnet-a,subnet-b",
        AWS_SECURITY_GROUP_IDS: "sg-a",
        IQUANTUM_CORS_ORIGINS:
          "https://app.example.com,https://admin.example.com",
        SENTRY_DSN: "https://public@example.com/1",
      }),
    ).toMatchObject({
      cloud: true,
      awsSubnetIds: ["subnet-a", "subnet-b"],
      awsSecurityGroupIds: ["sg-a"],
      corsOrigins: ["https://app.example.com", "https://admin.example.com"],
      sentryDsn: "https://public@example.com/1",
    });
  });

  describe("config file loading", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `iq-test-${Math.random().toString(36).slice(2)}`);
      await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("reads API key from config.json when env is empty", async () => {
      await writeFile(
        join(tmpDir, "config.json"),
        JSON.stringify({ ANTHROPIC_API_KEY: "from-file" }),
      );
      const config = loadConfig({}, { configDir: tmpDir });
      expect(config.anthropicApiKey).toBe("from-file");
    });

    it("env var wins over config file", async () => {
      await writeFile(
        join(tmpDir, "config.json"),
        JSON.stringify({ ANTHROPIC_API_KEY: "from-file" }),
      );
      const config = loadConfig(
        { ANTHROPIC_API_KEY: "from-env" },
        { configDir: tmpDir },
      );
      expect(config.anthropicApiKey).toBe("from-env");
    });

    it("reads sandboxImage from config file", async () => {
      await writeFile(
        join(tmpDir, "config.json"),
        JSON.stringify({
          ANTHROPIC_API_KEY: "key",
          IQUANTUM_SANDBOX_IMAGE: "custom/image:v1",
        }),
      );
      const config = loadConfig({}, { configDir: tmpDir });
      expect(config.sandboxImage).toBe("custom/image:v1");
    });

    it("silently ignores absent or malformed config file", () => {
      // tmpDir exists but has no config.json — should throw MissingApiKeyError, not a file error
      expect(() => loadConfig({}, { configDir: tmpDir })).toThrow(
        MissingApiKeyError,
      );
    });
  });
});
