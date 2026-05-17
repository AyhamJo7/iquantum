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
      }),
    ).toMatchObject({
      cloud: true,
      awsSubnetIds: ["subnet-a", "subnet-b"],
      awsSecurityGroupIds: ["sg-a"],
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
