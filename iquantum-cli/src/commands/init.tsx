import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, writeConfigFile } from "@iquantum/config";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { startDaemon } from "./daemon";
import {
  DEFAULT_ARCHITECT_MODEL,
  DEFAULT_EDITOR_MODEL,
  ensureInteractiveTerminal,
  type InitServices,
  runInit,
  validateApiKey,
} from "./init-state";

export interface InitWizardProps {
  onComplete(): void;
  configDir?: string;
  services?: Partial<InitServices>;
  startDaemonFn?: (socketPath: string) => Promise<void>;
  isTTY?: boolean;
}

type InitStep =
  | "apiKey"
  | "architectModel"
  | "editorModel"
  | "submitting"
  | "done";

export function InitWizard({
  onComplete,
  configDir = join(homedir(), ".iquantum"),
  services,
  startDaemonFn,
  isTTY = process.stdin.isTTY,
}: InitWizardProps) {
  ensureInteractiveTerminal(isTTY);

  const mergedServices = makeInitServices(services, startDaemonFn);
  const [step, setStep] = useState<InitStep>("apiKey");
  const [apiKey, setApiKey] = useState("");
  const [architectModel, setArchitectModel] = useState("");
  const [editorModel, setEditorModel] = useState("");
  const [error, setError] = useState<string>();
  const [statuses, setStatuses] = useState<string[]>([]);

  useInput((input, key) => {
    if (step === "submitting" || step === "done") {
      return;
    }

    if (key.backspace || key.delete) {
      updateCurrentValue((current) => current.slice(0, -1));
      return;
    }

    if (key.return) {
      if (step === "apiKey") {
        const validationError = validateApiKey(apiKey);

        if (validationError) {
          setError(validationError);
          return;
        }

        setError(undefined);
        setStep("architectModel");
        return;
      }

      if (step === "architectModel") {
        setStep("editorModel");
        return;
      }

      setStep("submitting");
      void runInit(
        { apiKey, architectModel, editorModel },
        configDir,
        mergedServices,
        (status) => setStatuses((current) => [...current, status]),
      )
        .then(() => {
          setStep("done");
          onComplete();
        })
        .catch((initError) => {
          setStep("editorModel");
          setError(
            initError instanceof Error ? initError.message : String(initError),
          );
        });
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      updateCurrentValue((current) => `${current}${input}`);
      setError(undefined);
    }
  });

  function updateCurrentValue(update: (current: string) => string): void {
    if (step === "apiKey") {
      setApiKey(update);
      return;
    }

    if (step === "architectModel") {
      setArchitectModel(update);
      return;
    }

    if (step === "editorModel") {
      setEditorModel(update);
    }
  }

  return (
    <Box flexDirection="column">
      <Text color="cyan">Welcome to iquantum</Text>
      <Text dimColor>First-run setup</Text>
      <Text>
        Anthropic API key:{" "}
        {apiKey ? "*".repeat(apiKey.length) : <Text dimColor>(required)</Text>}
      </Text>
      <Text>
        Architect model:{" "}
        {architectModel || <Text dimColor>[{DEFAULT_ARCHITECT_MODEL}]</Text>}
      </Text>
      <Text>
        Editor model:{" "}
        {editorModel || <Text dimColor>[{DEFAULT_EDITOR_MODEL}]</Text>}
      </Text>
      {error ? <Text color="red">{error}</Text> : null}
      {statuses.map((status) => (
        <Text key={status}>{status}</Text>
      ))}
      {step === "apiKey" ? (
        <Text dimColor>Enter API key, then press ↵</Text>
      ) : null}
      {step === "architectModel" ? (
        <Text dimColor>Enter architect model or press ↵ for default</Text>
      ) : null}
      {step === "editorModel" ? (
        <Text dimColor>Enter editor model or press ↵ for default</Text>
      ) : null}
    </Box>
  );
}

function makeInitServices(
  overrides: Partial<InitServices> | undefined,
  startDaemonFn: ((socketPath: string) => Promise<void>) | undefined,
): InitServices {
  return {
    writeConfigFile: overrides?.writeConfigFile ?? writeConfigFile,
    pullSandboxImage: overrides?.pullSandboxImage ?? pullSandboxImage,
    startDaemon:
      overrides?.startDaemon ??
      startDaemonFn ??
      ((socketPath) =>
        startDaemon({ socketPath }, { writeln: () => undefined })),
    loadConfig: overrides?.loadConfig ?? loadConfig,
  };
}

async function pullSandboxImage(
  image: string,
  onOutput: (chunk: string) => void = () => undefined,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("docker", ["pull", image], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`docker pull exited with code ${code ?? "?"}`));
    });
  });
}
