import { homedir } from "node:os";
import { join } from "node:path";
import { type IquantumConfig, loadConfig } from "@iquantum/config";
import type { Session } from "@iquantum/types";
import { Box, render, Text } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationEntry, DaemonClient } from "./client";
import { HttpDaemonClient } from "./client";
import { startDaemon } from "./commands/daemon";
import { InitWizard } from "./commands/init";
import { makeCommandRegistry } from "./commands/slash-commands";
import { Splash } from "./components/Splash";
import { REPL } from "./screens/REPL";
import type { TranscriptItem } from "./screens/repl-state";
import {
  readLastSession as defaultReadLastSession,
  writeLastSession as defaultWriteLastSession,
} from "./session-persist";
import { defaultSleep, ensureDaemonReady } from "./startup";
import { type LoadConfigFn, resolveStartupConfig } from "./startup/config";
import { checkForUpdate } from "./startup/version-check";
import { VERSION } from "./version";

export interface IQAppProps {
  client: DaemonClient;
  socketPath: string;
  modelName: string;
  editorModel: string;
  maxRetries: number;
  version: string;
  repoPath: string;
  iquantumDir?: string;
  skipSplash?: boolean;
  startDaemonFn?: () => Promise<void>;
  sleep?: (delayMs: number) => Promise<void>;
  readLastSession?: (dir: string) => Promise<string | null>;
  writeLastSession?: (dir: string, id: string) => Promise<void>;
}

export function IQApp({
  client,
  socketPath,
  modelName,
  editorModel,
  maxRetries,
  version,
  repoPath,
  iquantumDir,
  skipSplash = false,
  startDaemonFn,
  sleep,
  readLastSession = defaultReadLastSession,
  writeLastSession = defaultWriteLastSession,
}: IQAppProps) {
  const persistDir = iquantumDir ?? join(homedir(), ".iquantum");
  const updateStatus = useMemo(
    () => checkForUpdate(VERSION, persistDir),
    [persistDir],
  );
  const [session, setSession] = useState<Session>();
  const [initialMessages, setInitialMessages] = useState<TranscriptItem[]>([]);
  const [showRepl, setShowRepl] = useState(skipSplash);
  const registryRef = useRef(makeCommandRegistry());
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

        let resolvedSession: Session | undefined;
        let isResume = false;

        const savedId = await readLastSession(persistDir);
        if (savedId) {
          try {
            const candidateSession = (await client.getSession(
              savedId,
            )) as Session;
            // Sessions persist in SQLite, but only sessions recreated in the
            // current daemon process are actually resumable.
            await client.listCheckpoints(savedId);
            resolvedSession = candidateSession;
            isResume = true;
          } catch {
            // session no longer exists or is not live; create a fresh one
          }
        }

        if (!resolvedSession) {
          resolvedSession = await client.createSession(repoPath, {
            requireApproval: true,
            autoApprove: false,
          });
          await writeLastSession(persistDir, resolvedSession.id).catch(
            () => undefined,
          );
        }

        if (isResume && resolvedSession) {
          const page = await client
            .getMessages(resolvedSession.id, { limit: 50 })
            .catch(() => null);
          if (page && page.messages.length > 0 && active) {
            setInitialMessages(
              buildHistoryItems(page.messages, resolvedSession.id),
            );
          }
        }

        if (active) {
          setSession(resolvedSession);
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
  }, [
    client,
    persistDir,
    readLastSession,
    repoPath,
    sleep,
    socketPath,
    startDaemonFn,
    writeLastSession,
  ]);

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
      {updateStatus.updateAvailable && updateStatus.latestVersion ? (
        <Text dimColor>
          {`  update available: ${VERSION} → ${updateStatus.latestVersion}  (run iq update)`}
        </Text>
      ) : null}
      <REPL
        client={client}
        session={session}
        modelName={modelName}
        editorModel={editorModel}
        version={version}
        maxRetries={maxRetries}
        registry={registryRef.current}
        initialMessages={initialMessages}
      />
    </Box>
  );
}

export interface StartupAppProps {
  version: string;
  repoPath: string;
  iquantumDir?: string;
  loadConfigFn?: LoadConfigFn;
  clientFactory?: (socketPath: string) => DaemonClient;
  startDaemonFn?: (socketPath: string) => Promise<void>;
}

export function StartupApp({
  version,
  repoPath,
  iquantumDir,
  loadConfigFn = loadConfig,
  clientFactory = (socketPath) => new HttpDaemonClient(socketPath),
  startDaemonFn,
}: StartupAppProps) {
  const persistDir = iquantumDir ?? join(homedir(), ".iquantum");
  const [config, setConfig] = useState<IquantumConfig | null>(() =>
    resolveStartupConfig(loadConfigFn, persistDir),
  );
  const [error, setError] = useState<string>();
  const client = useMemo(
    () => (config ? clientFactory(config.socketPath) : null),
    [clientFactory, config],
  );

  const completeInit = useCallback(() => {
    try {
      setConfig(resolveStartupConfig(loadConfigFn, persistDir));
    } catch (startupError) {
      setError(
        startupError instanceof Error
          ? startupError.message
          : String(startupError),
      );
    }
  }, [loadConfigFn, persistDir]);

  if (error) {
    return <Text color="red">{error}</Text>;
  }

  if (!config || !client) {
    return (
      <InitWizard
        configDir={persistDir}
        onComplete={completeInit}
        {...(startDaemonFn ? { startDaemonFn } : {})}
      />
    );
  }

  return (
    <IQApp
      client={client}
      socketPath={config.socketPath}
      modelName={config.architectModel}
      editorModel={config.editorModel}
      maxRetries={config.maxRetries}
      version={version}
      repoPath={repoPath}
      iquantumDir={persistDir}
      {...(startDaemonFn
        ? { startDaemonFn: () => startDaemonFn(config.socketPath) }
        : {})}
    />
  );
}

function buildHistoryItems(
  entries: ConversationEntry[],
  sessionId: string,
): TranscriptItem[] {
  let counter = 0;
  const items: TranscriptItem[] = entries
    .filter((e) => e.role === "user" || e.role === "assistant")
    .map((e) => ({
      id: `history-${sessionId}-${counter++}`,
      type: "message" as const,
      role: (e.role === "assistant" ? "assistant" : "user") as
        | "user"
        | "assistant",
      text: e.content
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("\n")
        .trim(),
    }));

  items.push({ id: `history-sep-${sessionId}`, type: "session_separator" });
  return items;
}

export interface RenderAndRunOptions {
  version: string;
  repoPath?: string;
  iquantumDir?: string;
  loadConfigFn?: LoadConfigFn;
  clientFactory?: (socketPath: string) => DaemonClient;
  startDaemonFn?: (socketPath: string) => Promise<void>;
}

export async function renderAndRun(
  options: RenderAndRunOptions,
): Promise<void> {
  const app = render(
    <StartupApp
      version={options.version}
      repoPath={options.repoPath ?? process.cwd()}
      {...(options.iquantumDir ? { iquantumDir: options.iquantumDir } : {})}
      {...(options.loadConfigFn ? { loadConfigFn: options.loadConfigFn } : {})}
      {...(options.clientFactory
        ? { clientFactory: options.clientFactory }
        : {})}
      {...(options.startDaemonFn
        ? { startDaemonFn: options.startDaemonFn }
        : {})}
    />,
    { exitOnCtrlC: false },
  );

  await app.waitUntilExit();
}
