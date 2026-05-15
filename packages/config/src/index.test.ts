import { describe, expect, it } from "vitest";
import { loadConfig } from "./index";

const validEnv = {
  ANTHROPIC_API_KEY: "test-key",
  IQUANTUM_ARCHITECT_MODEL: "architect",
  IQUANTUM_EDITOR_MODEL: "editor",
  IQUANTUM_SOCKET: "/tmp/iquantum.sock",
  MAX_RETRIES: "3",
};

describe("loadConfig", () => {
  it("parses required environment variables", () => {
    expect(loadConfig(validEnv)).toEqual({
      anthropicApiKey: "test-key",
      architectModel: "architect",
      editorModel: "editor",
      socketPath: "/tmp/iquantum.sock",
      maxRetries: 3,
    });
  });

  it("rejects missing required variables", () => {
    expect(() => loadConfig({ ...validEnv, ANTHROPIC_API_KEY: "" })).toThrow();
  });

  it("uses release defaults for optional settings", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "test-key" })).toMatchObject({
      architectModel: "claude-sonnet-4-5",
      editorModel: "claude-haiku-4-5-20251001",
      maxRetries: 3,
    });
    expect(loadConfig({ ANTHROPIC_API_KEY: "test-key" }).socketPath).toContain(
      ".iquantum/daemon.sock",
    );
  });
});
