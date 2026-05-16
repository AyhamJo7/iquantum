#!/usr/bin/env bun
import { homedir } from "node:os";
import { resolve } from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import { renderAndRun } from "./app";
import { HttpDaemonClient } from "./client";
import { daemonStatus, startDaemon, stopDaemon } from "./commands/daemon";
import { runTask } from "./commands/task";
import { runUpdate } from "./commands/update";
import { VERSION } from "./version";

const DEFAULT_SOCKET = resolve(homedir(), ".iquantum", "daemon.sock");

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

const socketPath = expandHome(process.env.IQUANTUM_SOCKET ?? DEFAULT_SOCKET);

const stdoutWriter = {
  write: (chunk: string) => process.stdout.write(chunk),
  writeln: (line: string) => process.stdout.write(`${line}\n`),
};

async function readlinePrompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const program = new Command()
  .name("iq")
  .description("iquantum — AI coding agent CLI")
  .version(VERSION)
  .action(async () => {
    await renderAndRun({
      socketPath,
      modelName: process.env.IQUANTUM_ARCHITECT_MODEL ?? "claude-sonnet-4-5",
      version: VERSION,
    });
  });

program
  .command("task <prompt>")
  .description("Run a PIV task in the current repository")
  .option("--repo <path>", "Repository path (default: cwd)")
  .action(async (prompt: string, opts: { repo?: string }) => {
    try {
      await runTask(
        prompt,
        opts,
        new HttpDaemonClient(socketPath),
        readlinePrompt,
        stdoutWriter,
      );
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
  });

const daemon = program.command("daemon").description("Daemon lifecycle");

daemon
  .command("start")
  .description("Start the daemon in the background")
  .action(async () => {
    await startDaemon({ socketPath }, stdoutWriter);
  });

daemon
  .command("stop")
  .description("Stop the running daemon")
  .action(async () => {
    await stopDaemon({ socketPath }, stdoutWriter);
  });

daemon
  .command("status")
  .description("Check whether the daemon is running")
  .action(async () => {
    await daemonStatus(
      { client: new HttpDaemonClient(socketPath) },
      stdoutWriter,
    );
  });

program
  .command("update")
  .description("Update iq to the latest version")
  .action(async () => {
    try {
      await runUpdate(stdoutWriter);
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
