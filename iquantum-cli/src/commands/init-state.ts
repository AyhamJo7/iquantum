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

export function ensureInteractiveTerminal(isTTY: boolean | undefined): void {
  if (!isTTY) {
    throw new Error("iq init requires an interactive terminal");
  }
}
