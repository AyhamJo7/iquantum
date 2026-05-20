import type { IquantumConfig } from "@iquantum/config";
import { MissingApiKeyError } from "@iquantum/config";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("@iquantum/config", async () => {
  const actual =
    await vi.importActual<typeof import("@iquantum/config")>(
      "@iquantum/config",
    );
  return { ...actual, loadConfig: vi.fn() };
});

import { spawnSync } from "node:child_process";
import { loadConfig } from "@iquantum/config";
import {
  ApiKeyCheck,
  type CheckResult,
  ConfigFileCheck,
  DaemonHealthCheck,
  DaemonSocketCheck,
  DockerDaemonCheck,
  formatDoctorResults,
  SandboxImageCheck,
  VersionCheck,
} from "./doctor";

const mockSpawnSync = vi.mocked(spawnSync);
const mockLoadConfig = vi.mocked(loadConfig);

const fakeConfig = {
  providerApiKey: "sk-ant-test123",
  provider: "anthropic",
  sandboxImage: "iquantum/sandbox:latest",
  socketPath: "/tmp/iquantum-test.sock",
} as unknown as IquantumConfig;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DockerDaemonCheck", () => {
  it("returns ok when docker info exits 0", async () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<
      typeof spawnSync
    >);
    const result = await new DockerDaemonCheck().run();
    expect(result.status).toBe("ok");
    expect(result.label).toBe("Docker daemon");
  });

  it("returns fail when docker info exits non-zero", async () => {
    mockSpawnSync.mockReturnValue({ status: 1 } as ReturnType<
      typeof spawnSync
    >);
    const result = await new DockerDaemonCheck().run();
    expect(result.status).toBe("fail");
    expect(result.fix).toBeDefined();
  });
});

describe("SandboxImageCheck", () => {
  it("returns ok when image exists locally", async () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<
      typeof spawnSync
    >);
    const result = await new SandboxImageCheck(fakeConfig).run();
    expect(result.status).toBe("ok");
    expect(result.message).toBe("iquantum/sandbox:latest");
  });

  it("returns warn when image is not found locally", async () => {
    mockSpawnSync.mockReturnValue({ status: 1 } as ReturnType<
      typeof spawnSync
    >);
    const result = await new SandboxImageCheck(fakeConfig).run();
    expect(result.status).toBe("warn");
    expect(result.fix).toContain("docker pull");
  });
});

describe("ApiKeyCheck", () => {
  it("returns fail when API key is missing", async () => {
    const config = {
      ...fakeConfig,
      providerApiKey: undefined,
    } as unknown as IquantumConfig;
    const result = await new ApiKeyCheck(config).run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not configured");
  });

  it("returns ok immediately for non-Anthropic providers without a network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const config = {
      ...fakeConfig,
      provider: "openai",
      providerApiKey: "sk-openai-key",
    } as unknown as IquantumConfig;
    const result = await new ApiKeyCheck(config).run();
    expect(result.status).toBe("ok");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns fail when Anthropic returns 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
    const result = await new ApiKeyCheck(fakeConfig).run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("401");
  });

  it("returns ok for any non-401 response (key accepted)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 400 }));
    const result = await new ApiKeyCheck(fakeConfig).run();
    expect(result.status).toBe("ok");
  });

  it("returns warn when fetch throws (network unreachable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );
    const result = await new ApiKeyCheck(fakeConfig).run();
    expect(result.status).toBe("warn");
    expect(result.message).toContain("network");
  });
});

describe("DaemonSocketCheck", () => {
  it("returns ok when daemon responds with 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
    const result = await new DaemonSocketCheck(fakeConfig).run();
    expect(result.status).toBe("ok");
    expect(result.message).toContain(fakeConfig.socketPath);
  });

  it("returns warn when daemon responds with non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    const result = await new DaemonSocketCheck(fakeConfig).run();
    expect(result.status).toBe("warn");
    expect(result.message).toContain("503");
  });

  it("returns fail when fetch throws (daemon not running)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOENT")));
    const result = await new DaemonSocketCheck(fakeConfig).run();
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("iq daemon start");
  });
});

describe("DaemonHealthCheck", () => {
  it("returns ok when all components are healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, db: true, docker: true }),
      }),
    );
    const result = await new DaemonHealthCheck(fakeConfig).run();
    expect(result.status).toBe("ok");
    expect(result.message).toContain("healthy");
  });

  it("returns warn listing failing components", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, db: false, docker: true }),
      }),
    );
    const result = await new DaemonHealthCheck(fakeConfig).run();
    expect(result.status).toBe("warn");
    expect(result.message).toContain("db");
  });

  it("returns warn when daemon returns non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    const result = await new DaemonHealthCheck(fakeConfig).run();
    expect(result.status).toBe("warn");
  });

  it("returns warn when fetch throws (unreachable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );
    const result = await new DaemonHealthCheck(fakeConfig).run();
    expect(result.status).toBe("warn");
  });
});

describe("ConfigFileCheck", () => {
  it("returns ok when config loads successfully", async () => {
    mockLoadConfig.mockReturnValue({} as IquantumConfig);
    const result = await new ConfigFileCheck().run();
    expect(result.status).toBe("ok");
  });

  it("returns fail with fix hint when API key is missing", async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new MissingApiKeyError();
    });
    const result = await new ConfigFileCheck().run();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("API key missing");
    expect(result.fix).toContain("ANTHROPIC_API_KEY");
  });

  it("returns fail with error message for unexpected errors", async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("config file corrupted");
    });
    const result = await new ConfigFileCheck().run();
    expect(result.status).toBe("fail");
    expect(result.message).toBe("config file corrupted");
    expect(result.fix).toContain("iq init");
  });
});

describe("VersionCheck", () => {
  it("returns ok when installed version matches registry", async () => {
    const { VERSION } = await import("../version");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: VERSION }),
      }),
    );
    const result = await new VersionCheck().run();
    expect(result.status).toBe("ok");
    expect(result.message).toContain("up to date");
  });

  it("returns warn when a newer version is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: "999.0.0" }),
      }),
    );
    const result = await new VersionCheck().run();
    expect(result.status).toBe("warn");
    expect(result.message).toContain("999.0.0");
    expect(result.fix).toContain("iq update");
  });

  it("returns warn when fetch throws (network unavailable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );
    const result = await new VersionCheck().run();
    expect(result.status).toBe("warn");
  });

  it("returns warn when registry response is non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    const result = await new VersionCheck().run();
    expect(result.status).toBe("warn");
  });
});

describe("formatDoctorResults", () => {
  it("uses correct icons for each status", () => {
    const results: CheckResult[] = [
      { status: "ok", label: "Docker daemon", message: "running" },
      {
        status: "warn",
        label: "Version",
        message: "1.0.0 installed, 2.0.0 available",
        fix: "Run: iq update",
      },
      {
        status: "fail",
        label: "API key",
        message: "not configured",
        fix: "Set ANTHROPIC_API_KEY",
      },
    ];

    const output = formatDoctorResults(results);
    expect(output).toContain("[✓]");
    expect(output).toContain("[⚠]");
    expect(output).toContain("[✗]");
  });

  it("includes fix hint on a separate indented line", () => {
    const results: CheckResult[] = [
      {
        status: "fail",
        label: "API key",
        message: "not configured",
        fix: "Set ANTHROPIC_API_KEY",
      },
    ];

    const output = formatDoctorResults(results);
    expect(output).toContain("→ Set ANTHROPIC_API_KEY");
  });

  it("omits fix line when no fix is provided", () => {
    const results: CheckResult[] = [
      { status: "ok", label: "Docker daemon", message: "running" },
    ];

    const output = formatDoctorResults(results);
    expect(output).not.toContain("→");
  });
});
