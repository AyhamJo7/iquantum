import { describe, expect, it } from "vitest";
import {
  ensureInteractiveTerminal,
  resolveInitValues,
  runInit,
  validateApiKey,
} from "./init-state";

describe("validateApiKey", () => {
  it("requires a non-empty sk-prefixed key", () => {
    expect(validateApiKey("")).toBe("API key is required.");
    expect(validateApiKey("abc")).toBe("API key must start with sk-.");
    expect(validateApiKey("sk-ant-test")).toBeNull();
  });
});

describe("resolveInitValues", () => {
  it("uses model defaults when optional fields are blank", () => {
    expect(
      resolveInitValues({
        apiKey: " sk-ant-test ",
        architectModel: "",
        editorModel: " ",
      }),
    ).toEqual({
      apiKey: "sk-ant-test",
      architectModel: "claude-sonnet-4-6",
      editorModel: "claude-haiku-4-5-20251001",
      sandboxImage: "ghcr.io/ayhamjo7/iquantum-sandbox:latest",
    });
  });

  it("honors an explicit sandbox image override", () => {
    expect(
      resolveInitValues(
        {
          apiKey: "sk-ant-test",
          architectModel: "",
          editorModel: "",
        },
        { IQUANTUM_SANDBOX_IMAGE: "iquantum/sandbox:local" },
      ),
    ).toMatchObject({
      sandboxImage: "iquantum/sandbox:local",
    });
  });
});

describe("runInit", () => {
  it("writes config, prepares the image, then starts the daemon", async () => {
    const calls: unknown[][] = [];
    const statuses: string[] = [];

    await runInit(
      {
        apiKey: "sk-ant-test",
        architectModel: "",
        editorModel: "",
      },
      "/tmp/iq",
      {
        async writeConfigFile(dir, updates) {
          calls.push(["writeConfigFile", dir, updates]);
        },
        async pullSandboxImage(image, onOutput) {
          calls.push(["pullSandboxImage", image]);
          onOutput?.("pull progress\n");
        },
        async startDaemon(socketPath) {
          calls.push(["startDaemon", socketPath]);
        },
        loadConfig() {
          return {
            anthropicApiKey: "sk-ant-test",
            provider: "anthropic",
            baseUrl: undefined,
            apiKey: undefined,
            providerApiKey: "sk-ant-test",
            architectModel: "claude-sonnet-4-5",
            editorModel: "claude-haiku-4-5-20251001",
            socketPath: "/tmp/iq/daemon.sock",
            maxRetries: 3,
            execTimeoutMs: 120_000,
            mcpServers: [],
            sandboxImage: "ghcr.io/ayhamjo7/iquantum-sandbox:latest",
          };
        },
      },
      (status) => statuses.push(status),
    );

    expect(calls).toEqual([
      [
        "writeConfigFile",
        "/tmp/iq",
        {
          ANTHROPIC_API_KEY: "sk-ant-test",
          IQUANTUM_ARCHITECT_MODEL: "claude-sonnet-4-6",
          IQUANTUM_EDITOR_MODEL: "claude-haiku-4-5-20251001",
          IQUANTUM_SANDBOX_IMAGE: "ghcr.io/ayhamjo7/iquantum-sandbox:latest",
        },
      ],
      ["pullSandboxImage", "ghcr.io/ayhamjo7/iquantum-sandbox:latest"],
      ["startDaemon", "/tmp/iq/daemon.sock"],
    ]);
    expect(statuses).toContain("pull progress");
    expect(statuses.at(-1)).toBe("✓ Daemon started");
  });
});

describe("ensureInteractiveTerminal", () => {
  it("rejects non-interactive use", () => {
    expect(() => ensureInteractiveTerminal(false)).toThrow(
      "iq init requires an interactive terminal",
    );
  });
});
