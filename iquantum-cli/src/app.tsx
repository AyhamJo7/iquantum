import type { Session } from "@iquantum/types";
import { Box, render, Text } from "ink";
import { useCallback, useEffect, useState } from "react";
import type { DaemonClient } from "./client";
import { HttpDaemonClient } from "./client";
import { startDaemon } from "./commands/daemon";
import { Splash } from "./components/Splash";
import { REPL } from "./screens/REPL";
import { defaultSleep, ensureDaemonReady } from "./startup";

export interface IQAppProps {
  client: DaemonClient;
  socketPath: string;
  modelName: string;
  version: string;
  repoPath: string;
  skipSplash?: boolean;
  startDaemonFn?: () => Promise<void>;
  sleep?: (delayMs: number) => Promise<void>;
}

export function IQApp({
  client,
  socketPath,
  modelName,
  version,
  repoPath,
  skipSplash = false,
  startDaemonFn,
  sleep,
}: IQAppProps) {
  const [session, setSession] = useState<Session>();
  const [showRepl, setShowRepl] = useState(skipSplash);
  const [error, setError] = useState<string>();
  const completeSplash = useCallback(() => setShowRepl(true), []);

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        await ensureDaemonReady(
          client,
          startDaemonFn ??
            (() => startDaemon({ socketPath }, { writeln: () => undefined })),
          sleep ?? defaultSleep,
        );
        const createdSession = await client.createSession(repoPath, {
          requireApproval: true,
          autoApprove: false,
        });

        if (active) {
          setSession(createdSession);
        }
      } catch (startupError) {
        if (active) {
          setError(
            startupError instanceof Error
              ? startupError.message
              : String(startupError),
          );
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [client, repoPath, sleep, socketPath, startDaemonFn]);

  if (error) {
    return <Text color="red">{error}</Text>;
  }

  if (!session) {
    return <Text dimColor>Starting daemon…</Text>;
  }

  if (!showRepl) {
    return (
      <Splash
        version={version}
        modelName={modelName}
        sessionId={session.id}
        skip={skipSplash}
        onComplete={completeSplash}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <REPL client={client} session={session} modelName={modelName} />
    </Box>
  );
}

export interface RenderAndRunOptions {
  socketPath: string;
  modelName: string;
  version: string;
  repoPath?: string;
  client?: DaemonClient;
}

export async function renderAndRun(
  options: RenderAndRunOptions,
): Promise<void> {
  const app = render(
    <IQApp
      client={options.client ?? new HttpDaemonClient(options.socketPath)}
      socketPath={options.socketPath}
      modelName={options.modelName}
      version={options.version}
      repoPath={options.repoPath ?? process.cwd()}
    />,
  );

  await app.waitUntilExit();
}
