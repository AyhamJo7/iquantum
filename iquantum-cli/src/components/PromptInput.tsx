import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { navigateHistory } from "./prompt-history";

export interface PromptInputProps {
  disabled?: boolean;
  onSubmit(value: string): void | Promise<void>;
}

export function PromptInput({ disabled = false, onSubmit }: PromptInputProps) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  useInput(
    (input, key) => {
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
    <Box>
      <Text color="green">&gt; </Text>
      {value ? <Text>{value}</Text> : <Text dimColor> </Text>}
    </Box>
  );
}
