import { Box, Text, useInput } from "ink";
import { useRef } from "react";

export interface PermissionRequestProps {
  requestId: string;
  tool: string;
  input: unknown;
  onResolve: (requestId: string, approved: boolean) => void;
}

export function PermissionRequest({
  requestId,
  tool,
  input,
  onResolve,
}: PermissionRequestProps) {
  const resolvedRef = useRef(false);

  useInput((ch) => {
    if (resolvedRef.current) return;

    if (ch === "y" || ch === "Y") {
      resolvedRef.current = true;
      onResolve(requestId, true);
    }

    if (ch === "n" || ch === "N") {
      resolvedRef.current = true;
      onResolve(requestId, false);
    }
  });

  const inputSummary = input != null ? JSON.stringify(input).slice(0, 140) : "";

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="yellow">
        ◆ Allow tool: <Text bold>{tool}</Text>
      </Text>
      {inputSummary ? <Text dimColor> {inputSummary}</Text> : null}
      <Text dimColor> [y] approve [n] deny</Text>
    </Box>
  );
}
