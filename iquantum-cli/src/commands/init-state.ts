import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { loadConfig } from "@iquantum/config";

export const DEFAULT_ARCHITECT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_EDITOR_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_SANDBOX_IMAGE = "ghcr.io/ayhamjo7/iquantum-sandbox:latest";

export interface InitValues {
  apiKey: string;
  architectModel: string;
  editorModel: string;
}

export interface ResolvedInitValues {
  apiKey: string;
  architectModel: string;
  editorModel: string;
  sandboxImage: string;
}

export interface InitServices {
  writeConfigFile(dir: string, updates: Record<string, string>): Promise<void>;
  pullSandboxImage(
    image: string,
    onOutput?: (chunk: string) => void,
  ): Promise<void>;
  startDaemon(socketPath: string): Promise<void>;
  loadConfig: typeof loadConfig;
}

export function validateApiKey(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return "API key is required.";
  }

  if (!trimmed.startsWith("sk-")) {
    return "API key must start with sk-.";
  }

  if (trimmed.length < 8) {
    return "API key is too short.";
  }

  return null;
}

export function resolveInitValues(
  values: InitValues,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedInitValues {
  return {
    apiKey: values.apiKey.trim(),
    architectModel: values.architectModel.trim() || DEFAULT_ARCHITECT_MODEL,
    editorModel: values.editorModel.trim() || DEFAULT_EDITOR_MODEL,
    sandboxImage: env.IQUANTUM_SANDBOX_IMAGE?.trim() || DEFAULT_SANDBOX_IMAGE,
  };
}

export async function runInit(
  values: InitValues,
  configDir: string,
  services: InitServices,
  onStatus: (status: string) => void = () => undefined,
): Promise<ResolvedInitValues> {
  const resolved = resolveInitValues(values);
  await services.writeConfigFile(configDir, {
    ANTHROPIC_API_KEY: resolved.apiKey,
    IQUANTUM_ARCHITECT_MODEL: resolved.architectModel,
    IQUANTUM_EDITOR_MODEL: resolved.editorModel,
    IQUANTUM_SANDBOX_IMAGE: resolved.sandboxImage,
  });
  await writeExtensibilityScaffold(configDir);
  onStatus(`✓ Config saved → ${join(configDir, "config.json")}`);

  onStatus(`Pulling sandbox image ${resolved.sandboxImage}…`);
  await services.pullSandboxImage(resolved.sandboxImage, (chunk) => {
    const trimmed = chunk.trim();

    if (trimmed) {
      onStatus(trimmed);
    }
  });
  onStatus("✓ Sandbox image ready");

  const config = services.loadConfig(process.env, { configDir });
  onStatus("Starting daemon…");
  await services.startDaemon(config.socketPath);
  onStatus("✓ Daemon started");
  return resolved;
}

async function writeExtensibilityScaffold(configDir: string): Promise<void> {
  const hooksDir = join(configDir, "hooks");
  const skillsDir = join(configDir, "skills");
  await mkdir(hooksDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  await writeFile(
    join(hooksDir, "README.md"),
    [
      "# iquantum hooks",
      "",
      "Shell hooks default to post_validate.",
      "",
      "Shell hooks use a first-line event subscription:",
      "# events: post_validate,pre_apply_diff",
      "",
      "Hooks receive the event JSON on stdin and may print JSON like:",
      '{ "block": false, "message": "ok" }',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(skillsDir, "example.js"),
    [
      "export default {",
      '  name: "example",',
      '  description: "Example custom skill",',
      "  async run(args, ctx) {",
      '    ctx.dispatch({ type: "system_message", text: `example: $' +
        '{args}`, level: "info" });',
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(configDir, "keybindings.json"),
    JSON.stringify(
      {
        "ctrl+k ctrl+c": "compact",
        "ctrl+k ctrl+s": "status",
        "ctrl+k ctrl+d": "doctor",
        "ctrl+e": "export",
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function ensureInteractiveTerminal(isTTY: boolean | undefined): void {
  if (!isTTY) {
    throw new Error("iq init requires an interactive terminal");
  }
}
