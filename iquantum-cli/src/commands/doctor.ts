import { spawnSync } from "node:child_process";
import type { IquantumConfig } from "@iquantum/config";
import { loadConfig, MissingApiKeyError } from "@iquantum/config";
import { VERSION } from "../version";

// Cheapest Anthropic model — used only to probe key validity with a 1-token request.
const ANTHROPIC_PROBE_MODEL = "claude-3-haiku-20240307";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  status: CheckStatus;
  label: string;
  message: string;
  fix?: string;
}

export interface DoctorCheck {
  name: string;
  run(): Promise<CheckResult>;
}

export class DockerDaemonCheck implements DoctorCheck {
  name = "docker";

  async run(): Promise<CheckResult> {
    const result = spawnSync("docker", ["info"], {
      timeout: 5000,
      stdio: "pipe",
    });
    if (result.status === 0) {
      return { status: "ok", label: "Docker daemon", message: "running" };
    }
    return {
      status: "fail",
      label: "Docker daemon",
      message: "not running or not installed",
      fix: "Start Docker Desktop or run: sudo service docker start",
    };
  }
}

export class SandboxImageCheck implements DoctorCheck {
  name = "sandbox-image";
  readonly #config: IquantumConfig;

  constructor(config: IquantumConfig) {
    this.#config = config;
  }

  async run(): Promise<CheckResult> {
    const result = spawnSync(
      "docker",
      ["image", "inspect", this.#config.sandboxImage],
      { timeout: 10_000, stdio: "pipe" },
    );
    if (result.status === 0) {
      return {
        status: "ok",
        label: "Sandbox image",
        message: this.#config.sandboxImage,
      };
    }
    return {
      status: "warn",
      label: "Sandbox image",
      message: `${this.#config.sandboxImage} not found locally`,
      fix: `Run: docker pull ${this.#config.sandboxImage}`,
    };
  }
}

export class ApiKeyCheck implements DoctorCheck {
  name = "api-key";
  readonly #config: IquantumConfig;

  constructor(config: IquantumConfig) {
    this.#config = config;
  }

  async run(): Promise<CheckResult> {
    const key = this.#config.providerApiKey;
    if (!key) {
      return {
        status: "fail",
        label: "API key",
        message: "not configured",
        fix: "Set ANTHROPIC_API_KEY or IQUANTUM_API_KEY in your environment",
      };
    }

    if (this.#config.provider !== "anthropic") {
      return { status: "ok", label: "API key", message: "present" };
    }

    if (!key.startsWith("sk-ant-")) {
      return {
        status: "warn",
        label: "API key",
        message: "key format looks incorrect for Anthropic",
      };
    }

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: ANTHROPIC_PROBE_MODEL,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (response.status === 401) {
        return {
          status: "fail",
          label: "API key",
          message: "authentication failed (401)",
          fix: "Check your API key at console.anthropic.com",
        };
      }

      return { status: "ok", label: "API key", message: "valid" };
    } catch {
      return {
        status: "warn",
        label: "API key",
        message: "could not verify (network unreachable)",
      };
    }
  }
}

export class ConfigFileCheck implements DoctorCheck {
  name = "config-file";

  async run(): Promise<CheckResult> {
    try {
      loadConfig();
      return { status: "ok", label: "Config file", message: "loaded" };
    } catch (error) {
      if (error instanceof MissingApiKeyError) {
        return {
          status: "fail",
          label: "Config file",
          message: "API key missing",
          fix: "Run: iq config set ANTHROPIC_API_KEY sk-ant-...",
        };
      }
      return {
        status: "fail",
        label: "Config file",
        message: error instanceof Error ? error.message : String(error),
        fix: "Run: iq init",
      };
    }
  }
}

export class DaemonSocketCheck implements DoctorCheck {
  name = "daemon-socket";
  readonly #config: IquantumConfig;

  constructor(config: IquantumConfig) {
    this.#config = config;
  }

  async run(): Promise<CheckResult> {
    try {
      const response = await fetch(`http://localhost/health`, {
        signal: AbortSignal.timeout(3000),
        unix: this.#config.socketPath,
      } as RequestInit);

      if (response.ok) {
        return {
          status: "ok",
          label: "Daemon socket",
          message: `reachable at ${this.#config.socketPath}`,
        };
      }

      return {
        status: "warn",
        label: "Daemon socket",
        message: `daemon responded with status ${response.status}`,
      };
    } catch {
      return {
        status: "fail",
        label: "Daemon socket",
        message: "daemon not running",
        fix: "Run: iq daemon start",
      };
    }
  }
}

export class DaemonHealthCheck implements DoctorCheck {
  name = "daemon-health";
  readonly #config: IquantumConfig;

  constructor(config: IquantumConfig) {
    this.#config = config;
  }

  async run(): Promise<CheckResult> {
    try {
      const response = await fetch(`http://localhost/health`, {
        signal: AbortSignal.timeout(3000),
        unix: this.#config.socketPath,
      } as RequestInit);

      if (!response.ok) {
        return {
          status: "warn",
          label: "Daemon health",
          message: "daemon returned non-200 status",
        };
      }

      const status = (await response.json()) as {
        db?: boolean;
        docker?: boolean;
        redis?: boolean;
      };

      const failing = Object.entries(status)
        .filter(([k, v]) => k !== "ok" && v === false)
        .map(([k]) => k);

      if (failing.length > 0) {
        return {
          status: "warn",
          label: "Daemon health",
          message: `components unhealthy: ${failing.join(", ")}`,
        };
      }

      return {
        status: "ok",
        label: "Daemon health",
        message: "all components healthy",
      };
    } catch {
      return {
        status: "warn",
        label: "Daemon health",
        message: "could not reach daemon for health check",
      };
    }
  }
}

export class VersionCheck implements DoctorCheck {
  name = "version";

  async run(): Promise<CheckResult> {
    try {
      const response = await fetch(
        "https://registry.npmjs.org/@iquantum/cli/latest",
        { signal: AbortSignal.timeout(5000) },
      );

      if (!response.ok) {
        return {
          status: "warn",
          label: "Version",
          message: "could not check for updates",
        };
      }

      const data = (await response.json()) as { version?: string };
      const latest = data.version;

      if (!latest) {
        return {
          status: "warn",
          label: "Version",
          message: "could not parse registry response",
        };
      }

      if (latest !== VERSION) {
        return {
          status: "warn",
          label: "Version",
          message: `${VERSION} installed, ${latest} available`,
          fix: "Run: iq update",
        };
      }

      return {
        status: "ok",
        label: "Version",
        message: `${VERSION} (up to date)`,
      };
    } catch {
      return {
        status: "warn",
        label: "Version",
        message: "could not check for updates (network unavailable)",
      };
    }
  }
}

export async function runAllChecks(
  config: IquantumConfig,
): Promise<CheckResult[]> {
  const checks: DoctorCheck[] = [
    new ConfigFileCheck(),
    new DockerDaemonCheck(),
    new SandboxImageCheck(config),
    new ApiKeyCheck(config),
    new DaemonSocketCheck(config),
    new DaemonHealthCheck(config),
    new VersionCheck(),
  ];

  return Promise.all(checks.map((check) => check.run()));
}

export function formatDoctorResults(results: CheckResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const icon =
      result.status === "ok" ? "[✓]" : result.status === "warn" ? "[⚠]" : "[✗]";
    const label = result.label.padEnd(16);
    lines.push(`${icon} ${label} ${result.message}`);
    if (result.fix) {
      lines.push(`    → ${result.fix}`);
    }
  }
  return lines.join("\n");
}

export async function runDoctor(config: IquantumConfig): Promise<void> {
  process.stdout.write("Running diagnostics…\n\n");
  const results = await runAllChecks(config);
  process.stdout.write(`${formatDoctorResults(results)}\n`);
  const hasFail = results.some((r) => r.status === "fail");
  process.exit(hasFail ? 1 : 0);
}
