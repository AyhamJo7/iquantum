import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { CommandRegistry } from "../commands/registry";
import { navigateHistory } from "./prompt-history";
import { COPY, STATUS_COLORS } from "./theme";

export interface PromptInputProps {
  disabled?: boolean;
  onSubmit(value: string): void | Promise<void>;
  registry?: CommandRegistry;
  isFirstSubmit: boolean;
}

export function PromptInput({
  disabled = false,
  onSubmit,
  registry,
  isFirstSubmit,
}: PromptInputProps) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    if (disabled) {
      setCursorVisible(false);
      return;
    }

    const timer = setInterval(() => {
      setCursorVisible((current) => !current);
    }, 530);

    return () => clearInterval(timer);
  }, [disabled]);

  const completionPrefix =
    value.startsWith("/") && registry ? value.slice(1) : null;
  const completions =
    completionPrefix !== null && registry
      ? registry.getCompletions(completionPrefix)
      : [];

  useInput(
    (input, key) => {
      if (key.tab) {
        const first = completions[0];

        if (first) {
          setValue(`/${first.name} `);
          setHistoryIndex(null);
        }

        return;
      }

      if (key.return) {
        const submitted = value.trim();

        if (submitted) {
          void onSubmit(submitted);
          setHistory((current) => [...current, submitted]);
        }

        setValue("");
        setHistoryIndex(null);
        return;
      }

      if (key.backspace || key.delete) {
        setValue((current) => current.slice(0, -1));
        return;
      }

      if (key.upArrow) {
        const selection = navigateHistory(history, historyIndex, "up");

        if (selection) {
          setHistoryIndex(selection.index);
          setValue(selection.value);
        }

        return;
      }

      if (key.downArrow) {
        const selection = navigateHistory(history, historyIndex, "down");

        if (selection) {
          setHistoryIndex(selection.index);
          setValue(selection.value);
        }

        return;
      }

      if (!key.ctrl && !key.meta && input) {
        setValue((current) => `${current}${input}`);
        setHistoryIndex(null);
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column">
      {completions.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {completions.slice(0, 5).map((cmd) => (
            <Text key={cmd.name} dimColor>
              /{cmd.name} — {cmd.description}
            </Text>
          ))}
        </Box>
      ) : null}
      {!isFirstSubmit && value === "" ? (
        <Text dimColor>{COPY.hintIdle}</Text>
      ) : null}
      <Box>
        <Text color={STATUS_COLORS.success}>&gt; </Text>
        <Text>
          {value}
          {disabled || !cursorVisible ? " " : "█"}
        </Text>
      </Box>
    </Box>
  );
}
