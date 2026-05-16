import type { DaemonClient } from "../client";
import { isDaemonNotRunning } from "../client";

export interface TaskOptions {
  repo?: string;
}

export type PromptFn = (question: string) => Promise<string>;

export interface Writer {
  write(chunk: string): void;
  writeln(line: string): void;
}

export async function runTask(
  prompt: string,
  options: TaskOptions,
  client: DaemonClient,
  promptFn: PromptFn,
  writer: Writer,
): Promise<void> {
  const repoPath = options.repo ?? process.cwd();

  let session: import("@iquantum/types").Session | undefined;

  try {
    session = await client.createSession(repoPath, {
      requireApproval: true,
      autoApprove: true,
    });
  } catch (error) {
    if (isDaemonNotRunning(error)) {
      writer.writeln(
        "daemon is not running — start it first with: iq daemon start",
      );
      return;
    }

    throw error;
  }

  // Establish stream before issuing HTTP calls so no events are missed.
  const stream = client.openStream(session.id);

  // planning — blocks until plan_ready is emitted
  let pendingPlan: Promise<import("@iquantum/types").Plan> = client.startTask(
    session.id,
    prompt,
  );

  try {
    for await (const frame of stream) {
      switch (frame.type) {
        case "token":
          writer.write(frame.delta);
          break;

        case "phase_change":
          if (frame.phase === "implementing") {
            writer.writeln("\n\nImplementing...");
          } else if (frame.phase === "validating") {
            writer.writeln("\nValidating...");
          }
          break;

        case "validate_result":
          writer.writeln(
            frame.passed
              ? `  ✓ tests passed (attempt ${frame.attempt})`
              : `  ✗ tests failed (attempt ${frame.attempt}), retrying...`,
          );
          break;

        case "plan_ready": {
          const plan = await pendingPlan;
          writer.writeln("\n\n=== Plan ===\n");
          writer.writeln(plan.content);
          writer.writeln("");

          const decision = await promptFn(
            "Approve? [y]es / [n]o+feedback / [q]uit: ",
          );

          if (decision === "q" || decision === "quit") {
            void client.destroySession(session.id).catch(() => undefined);
            return;
          }

          if (decision === "" || decision === "y" || decision === "yes") {
            void client.approve(session.id).catch(() => undefined);
          } else {
            const feedback = await promptFn("Feedback: ");
            pendingPlan = client.reject(session.id, feedback);
          }

          break;
        }

        case "checkpoint":
          writer.writeln(`\n✓ Committed: ${frame.hash}`);
          return;

        case "error":
          throw new Error(`Engine error: ${frame.message}`);
      }
    }
  } catch (error) {
    void client.destroySession(session.id).catch(() => undefined);
    throw error;
  }
}
