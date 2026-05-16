import {
  type IquantumConfig,
  type loadConfig,
  MissingApiKeyError,
} from "@iquantum/config";

export type LoadConfigFn = typeof loadConfig;

export function resolveStartupConfig(
  loadConfigFn: LoadConfigFn,
  configDir: string,
): IquantumConfig | null {
  try {
    return loadConfigFn(process.env, { configDir });
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return null;
    }

    throw error;
  }
}
