import * as Sentry from "@sentry/bun";

export interface ErrorReporter {
  captureException(error: unknown, context?: Record<string, unknown>): void;
  flush?(): Promise<void>;
}

export function createErrorReporter(dsn?: string): ErrorReporter | undefined {
  if (!dsn) {
    return undefined;
  }

  Sentry.init({ dsn });

  return {
    captureException(error, context) {
      Sentry.withScope((scope) => {
        for (const [key, value] of Object.entries(context ?? {})) {
          scope.setExtra(key, value);
        }
        Sentry.captureException(error);
      });
    },
    async flush() {
      await Sentry.flush(2_000);
    },
  };
}
