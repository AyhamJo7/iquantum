import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  IQUANTUM_ARCHITECT_MODEL: z.string().min(1),
  IQUANTUM_EDITOR_MODEL: z.string().min(1),
  IQUANTUM_SOCKET: z.string().min(1),
  MAX_RETRIES: z.coerce.number().int().min(1),
});

export interface IquantumConfig {
  anthropicApiKey: string;
  architectModel: string;
  editorModel: string;
  socketPath: string;
  maxRetries: number;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): IquantumConfig {
  const parsed = envSchema.parse(env);

  return {
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    architectModel: parsed.IQUANTUM_ARCHITECT_MODEL,
    editorModel: parsed.IQUANTUM_EDITOR_MODEL,
    socketPath: expandHome(parsed.IQUANTUM_SOCKET),
    maxRetries: parsed.MAX_RETRIES,
  };
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}
