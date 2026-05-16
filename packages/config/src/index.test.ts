import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, MissingApiKeyError } from "./index";

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
      architectModel: "architect",
      editorModel: "editor",
      socketPath: "/tmp/iquantum.sock",
      maxRetries: 3,
      execTimeoutMs: 45_000,
      mcpServers: [],
      sandboxImage: "ghcr.io/ayhamjo7/iquantum-sandbox:latest",
    });
  });

  it("throws MissingApiKeyError when API key is absent", () => {
    expect(() => loadConfig({})).toThrow(MissingApiKeyError);
    expect(() => loadConfig({})).toThrow("ANTHROPIC_API_KEY is not set");
  });

  it("throws MissingApiKeyError (not a raw ZodError) when key is empty string", () => {
    expect(() => loadConfig({ ...validEnv, ANTHROPIC_API_KEY: "" })).toThrow(
      MissingApiKeyError,
    );
  });

  it("uses release defaults for optional settings", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "test-key" })).toMatchObject({
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
