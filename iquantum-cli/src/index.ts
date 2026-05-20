#!/usr/bin/env bun
import { homedir } from "node:os";
import { resolve } from "node:path";
import readline from "node:readline";
import { loadConfig, MissingApiKeyError } from "@iquantum/config";
import { Command } from "commander";
import { render } from "ink";
import { createElement } from "react";
import { renderAndRun } from "./app";
import { HttpDaemonClient } from "./client";
import { runChat } from "./commands/chat";
import { configGet, configList, configSet } from "./commands/config";
import { daemonStatus, startDaemon, stopDaemon } from "./commands/daemon";
import { runDoctor } from "./commands/doctor";
import { InitWizard } from "./commands/init";
import { runReviewCommand } from "./commands/review";
import { runTask } from "./commands/task";
import { runUpdate } from "./commands/update";
import { VERSION } from "./version";

const DEFAULT_SOCKET = resolve(homedir(), ".iquantum", "daemon.sock");

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

function configuredSocketPath(): string {
  try {
    return loadConfig().socketPath;
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return expandHome(process.env.IQUANTUM_SOCKET ?? DEFAULT_SOCKET);
    }

    throw error;
  }
}

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
      version: VERSION,
    });
  });

program
  .command("chat")
  .description("Open a conversational session (no plan/implement/validate)")
  .action(async () => {
    await runChat(process.cwd());
  });

program
  .command("task <prompt>")
  .description("Run a PIV task in the current repository")
  .option("--repo <path>", "Repository path (default: cwd)")
  .option(
    "--extra-repo <path>",
    "Additional repository to include in context (repeatable)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "--effort <level>",
    "Effort level: fast | normal | thorough (default: normal)",
  )
  .action(
    async (
      prompt: string,
      opts: { repo?: string; extraRepo?: string[]; effort?: string },
    ) => {
      try {
        await runTask(
          prompt,
          opts,
          new HttpDaemonClient(configuredSocketPath()),
          readlinePrompt,
          stdoutWriter,
        );
      } catch (error) {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      }
    },
  );

const daemon = program.command("daemon").description("Daemon lifecycle");

daemon
  .command("start")
  .description("Start the daemon in the background")
  .action(async () => {
    await startDaemon({ socketPath: configuredSocketPath() }, stdoutWriter);
  });

daemon
  .command("stop")
  .description("Stop the running daemon")
  .action(async () => {
    await stopDaemon({ socketPath: configuredSocketPath() }, stdoutWriter);
  });

daemon
  .command("status")
  .description("Check whether the daemon is running")
  .action(async () => {
    await daemonStatus(
      { client: new HttpDaemonClient(configuredSocketPath()) },
      stdoutWriter,
    );
  });

const config = program
  .command("config")
  .description("Read and write ~/.iquantum/config.json");

config
  .command("list")
  .description("Print all configured values (API key is redacted)")
  .action(() => {
    configList(stdoutWriter);
  });

config
  .command("set <KEY> <value>")
  .description("Set a config value")
  .action(async (key: string, value: string) => {
    await configSet(key, value, stdoutWriter);
  });

config
  .command("get <KEY>")
  .description("Get a config value")
  .action((key: string) => {
    configGet(key, stdoutWriter);
  });

program
  .command("init")
  .description("Run first-time setup")
  .action(async () => {
    try {
      const app = render(
        createElement(InitWizard, { onComplete: () => app.unmount() }),
        { exitOnCtrlC: false },
      );
      await app.waitUntilExit();
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("review")
  .description("Review staged changes, a commit, a path, or a pull request")
  .option("--repo <path>", "Repository path (default: cwd)")
  .option("--staged", "Review staged changes (default)")
  .option("--commit <ref>", "Review one commit")
  .option("--path <path>", "Review changes to a path against HEAD")
  .option("--pr <ref>", "Review a GitHub pull request")
  .action(
    async (opts: {
      repo?: string;
      staged?: boolean;
      commit?: string;
      path?: string;
      pr?: string;
    }) => {
      try {
        await runReviewCommand(
          opts,
          new HttpDaemonClient(configuredSocketPath()),
          stdoutWriter,
        );
      } catch (error) {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      }
    },
  );

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

program
  .command("doctor")
  .description("Run system diagnostics and check configuration")
  .action(async () => {
    try {
      const config = loadConfig();
      await runDoctor(config);
    } catch (error) {
      if (error instanceof MissingApiKeyError) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      }
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
