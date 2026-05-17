import { Box, Text } from "ink";
import { useEffect, useState } from "react";

export interface ThinkingBlockProps {
  text: string;
  expanded: boolean;
  isStreaming: boolean;
}

const dots = ["·", "··", "···"] as const;

export function ThinkingBlock({
  text,
  expanded,
  isStreaming,
}: ThinkingBlockProps) {
  const [dotsIndex, setDotsIndex] = useState(0);

  useEffect(() => {
    if (!isStreaming || expanded) {
      return;
    }

    const timer = setInterval(() => {
      setDotsIndex((current) => (current + 1) % dots.length);
    }, 400);

    return () => clearInterval(timer);
  }, [expanded, isStreaming]);

  const preview = text.length > 80 ? `${text.slice(0, 79)}…` : text;

  return (
    <Box flexDirection="column">
      <Text dimColor>
        ∴ Thinking
        {!expanded && isStreaming ? dots[dotsIndex] : ""}{" "}
        {expanded ? "[ctrl+o to collapse]" : "[ctrl+o to expand]"}
      </Text>
      {expanded ? (
        <Text dimColor>{text}</Text>
      ) : preview ? (
        <Text dimColor>{preview}</Text>
      ) : null}
    </Box>
  );
}
