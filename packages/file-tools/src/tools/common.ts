import type { ExecChunk, ExecResult } from "@iquantum/sandbox";

export type SandboxExec = (
  sessionId: string,
  command: string,
) => Promise<ExecResult>;

export async function collectExec(
  result: ExecResult,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";

  for await (const chunk of result.output) {
    if (chunk.stream === "stdout") {
      stdout += chunk.data;
    } else {
      stderr += chunk.data;
    }
  }

  return {
    stdout,
    stderr,
    exitCode: await result.exitCode,
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function stripWorkspacePrefix(output: string): string {
  return output.replace(/^\/workspace\//gm, "");
}

export function execResult(
  stdout: string,
  stderr = "",
  exitCode = 0,
): ExecResult {
  const chunks: ExecChunk[] = [
    ...(stdout ? [{ stream: "stdout" as const, data: stdout }] : []),
    ...(stderr ? [{ stream: "stderr" as const, data: stderr }] : []),
  ];

  return {
    output: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    },
    exitCode: Promise.resolve(exitCode),
  };
}
