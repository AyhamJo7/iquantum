import { MissingApiKeyError } from "@iquantum/config";
import { describe, expect, it } from "vitest";
import { resolveStartupConfig } from "./startup/config";

describe("resolveStartupConfig", () => {
  it("returns null when config is missing the API key", () => {
    const result = resolveStartupConfig(() => {
      throw new MissingApiKeyError();
    }, "/tmp/iq");

    expect(result).toBeNull();
  });

  it("returns parsed config when available", () => {
    const result = resolveStartupConfig(
      () => ({
        anthropicApiKey: "sk-ant-test",
        provider: "anthropic",
        baseUrl: undefined,
        apiKey: undefined,
        providerApiKey: "sk-ant-test",
        architectModel: "architect",
        editorModel: "editor",
        socketPath: "/tmp/iq.sock",
        tcpPort: 51820,
        maxRetries: 3,
        execTimeoutMs: 120_000,
        mcpServers: [],
        sandboxImage: "image",
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
      }),
      "/tmp/iq",
    );

    expect(result?.socketPath).toBe("/tmp/iq.sock");
  });

  it("rethrows unrelated startup errors", () => {
    expect(() =>
      resolveStartupConfig(() => {
        throw new Error("bad config");
      }, "/tmp/iq"),
    ).toThrow("bad config");
  });
});
