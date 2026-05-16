import { Box, Text, useInput } from "ink";
import { useRef } from "react";
import { BORDERS, STATUS_COLORS } from "./theme";

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

  const inputRows = inputSummaryRows(input);

  return (
    <Box flexDirection="column" marginY={1} {...BORDERS.warning}>
      <Text bold>tool approval needed</Text>
      <Text color={STATUS_COLORS.warning} bold>
        {tool}
      </Text>
      {inputRows.map((row) => (
        <Text key={row} dimColor>
          {row}
        </Text>
      ))}
      <Text dimColor>[y] approve [n] deny</Text>
    </Box>
  );
}

function inputSummaryRows(input: unknown): string[] {
  if (isPlainObject(input)) {
    return Object.entries(input).map(
      ([key, value]) => `${key}: ${JSON.stringify(value).slice(0, 140)}`,
    );
  }

  if (typeof input === "string") {
    return [input.slice(0, 140)];
  }

  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
