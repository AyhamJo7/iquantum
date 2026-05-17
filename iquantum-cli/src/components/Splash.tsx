import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";

const SPLASH_ART = [
  "██╗  ██████╗  ██╗   ██╗  █████╗  ███╗   ██╗ ████████╗ ██╗   ██╗ ███╗   ███╗",
  "██║ ██╔═══██╗ ██║   ██║ ██╔══██╗ ████╗  ██║ ╚══██╔══╝ ██║   ██║ ████╗ ████║",
  "██║ ██║   ██║ ██║   ██║ ███████║ ██╔██╗ ██║    ██║    ██║   ██║ ██╔████╔██║",
  "██║ ██║▄▄ ██║ ██║   ██║ ██╔══██║ ██║╚██╗██║    ██║    ██║   ██║ ██║╚██╔╝██║",
  "██║ ╚██████╔╝ ╚██████╔╝ ██║  ██║ ██║ ╚████║    ██║    ╚██████╔╝ ██║ ╚═╝ ██║",
  "╚═╝  ╚══▀▀═╝   ╚═════╝  ╚═╝  ╚═╝ ╚═╝  ╚═══╝    ╚═╝     ╚═════╝  ╚═╝     ╚═╝",
] as const;

// Top-to-bottom gradient: orange → pink → purple → teal
const ROW_COLORS = [
  "#f4a261",
  "#e07098",
  "#c060c0",
  "#9050d0",
  "#6070d8",
  "#40b8b8",
] as const;

export interface SplashProps {
  version: string;
  modelName: string;
  sessionId: string;
  skip?: boolean;
  onComplete(): void;
}

export function Splash({
  version,
  modelName,
  sessionId,
  skip = false,
  onComplete,
}: SplashProps) {
  const maxColumns = useMemo(
    () => Math.max(...SPLASH_ART.map((line) => line.length)),
    [],
  );
  const [visibleColumns, setVisibleColumns] = useState(skip ? maxColumns : 0);
  const [showMetadata, setShowMetadata] = useState(skip);

  useEffect(() => {
    if (skip) {
      onComplete();
      return;
    }

    const timer = setInterval(() => {
      setVisibleColumns((current) => {
        const next = Math.min(maxColumns, current + 1);

        if (next === maxColumns) {
          clearInterval(timer);
        }

        return next;
      });
    }, 8);

    return () => clearInterval(timer);
  }, [maxColumns, onComplete, skip]);

  useEffect(() => {
    if (visibleColumns < maxColumns || showMetadata) {
      return;
    }

    setShowMetadata(true);
    onComplete();
  }, [maxColumns, onComplete, showMetadata, visibleColumns]);

  return (
    <Box flexDirection="column">
      <Text dimColor>v{version}</Text>
      {SPLASH_ART.map((line, i) => (
        <Text key={line} color={ROW_COLORS[i] ?? "white"}>
          {line.slice(0, visibleColumns)}
        </Text>
      ))}
      {showMetadata ? (
        <>
          <Text>The AI coding agent with a stateful sandbox. {modelName}</Text>
          <Text dimColor>
            /help for commands · ctrl+c to exit · session:{" "}
            {sessionId.slice(0, 8)}
          </Text>
        </>
      ) : null}
    </Box>
  );
}
