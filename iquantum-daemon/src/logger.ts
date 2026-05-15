const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const rawLevel = process.env.LOG_LEVEL ?? "info";
const currentLevel: number = LEVELS[rawLevel as Level] ?? LEVELS.info;

function emit(level: Level, data: Record<string, unknown>): void {
  if (LEVELS[level] > currentLevel) return;
  process.stdout.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), ...data })}\n`,
  );
}

export const logger = {
  info: (data: Record<string, unknown>) => emit("info", data),
  warn: (data: Record<string, unknown>) => emit("warn", data),
  error: (data: Record<string, unknown>) => emit("error", data),
  debug: (data: Record<string, unknown>) => emit("debug", data),
};
