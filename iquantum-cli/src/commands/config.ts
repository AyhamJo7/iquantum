import { homedir } from "node:os";
import { join } from "node:path";
import { readConfigFileSync, writeConfigFile } from "@iquantum/config";
import type { Writer } from "./daemon";

/** All keys users can set via `iq config set`. */
export const KNOWN_CONFIG_KEYS = [
  "ANTHROPIC_API_KEY",
  "IQUANTUM_ARCHITECT_MODEL",
  "IQUANTUM_EDITOR_MODEL",
  "IQUANTUM_SOCKET",
  "IQUANTUM_SANDBOX_IMAGE",
  "IQUANTUM_EXEC_TIMEOUT_MS",
  "IQUANTUM_MCP_SERVERS",
  "MAX_RETRIES",
] as const;

export type ConfigKey = (typeof KNOWN_CONFIG_KEYS)[number];

function isKnownKey(key: string): key is ConfigKey {
  return (KNOWN_CONFIG_KEYS as readonly string[]).includes(key);
}

function redact(key: string, value: string): string {
  if (key === "ANTHROPIC_API_KEY" && value.length > 7) {
    return `${value.slice(0, 3)}...${value.slice(-4)}`;
  }
  return value;
}

function defaultConfigDir(): string {
  return join(homedir(), ".iquantum");
}

export function configList(
  writer: Writer,
  configDir = defaultConfigDir(),
): void {
  const cfg = readConfigFileSync(configDir);
  const entries = Object.entries(cfg);

  if (entries.length === 0) {
    writer.writeln("No config file found. Run `iq init` to create one.");
    return;
  }

  for (const [key, value] of entries) {
    if (typeof value === "string") {
      writer.writeln(`${key}=${redact(key, value)}`);
    }
  }
}

export async function configSet(
  key: string,
  value: string,
  writer: Writer,
  configDir = defaultConfigDir(),
): Promise<void> {
  if (!isKnownKey(key)) {
    writer.writeln(
      `Unknown config key: ${key}\nKnown keys: ${KNOWN_CONFIG_KEYS.join(", ")}`,
    );
    return;
  }

  await writeConfigFile(configDir, { [key]: value });
  writer.writeln(`set ${key}`);
}

export function configGet(
  key: string,
  writer: Writer,
  configDir = defaultConfigDir(),
): void {
  if (!isKnownKey(key)) {
    writer.writeln(
      `Unknown config key: ${key}\nKnown keys: ${KNOWN_CONFIG_KEYS.join(", ")}`,
    );
    return;
  }

  const cfg = readConfigFileSync(configDir);
  const value = cfg[key];

  if (typeof value !== "string") {
    writer.writeln(`(not set)`);
    return;
  }

  writer.writeln(redact(key, value));
}
