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
        hooksDir: "/tmp/iq/hooks",
        hookTimeoutMs: 5000,
        skillsDir: "/tmp/iq/skills",
        keybindingsFile: "/tmp/iq/keybindings.json",
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
