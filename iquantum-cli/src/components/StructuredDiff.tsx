import { Box, Text } from "ink";
import { parseDiffLines } from "./diff-parser";
import { STATUS_COLORS } from "./theme";

export interface StructuredDiffProps {
  file: string;
  patch: string;
  addCount: number;
  delCount: number;
}

export function StructuredDiff({
  file,
  patch,
  addCount,
  delCount,
}: StructuredDiffProps) {
  const lines = parseDiffLines(patch);
  const keyed = lines.map((line, i) => ({
    ...line,
    key: `${file}:${i}:${line.type}`,
  }));

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text dimColor>┌─ {truncateFilePath(file)} </Text>
        <Text color={STATUS_COLORS.success}>+{addCount}</Text>
        <Text dimColor> </Text>
        <Text color={STATUS_COLORS.error}>−{delCount}</Text>
        <Text dimColor> ─────┐</Text>
      </Box>
      {keyed.map((line) => {
        const gutter =
          line.lineNo === null ? "    " : `${line.lineNo}`.padStart(4, " ");

        switch (line.type) {
          case "add":
            return (
              <Box key={line.key}>
                <Text dimColor>{gutter} </Text>
                <Text color={STATUS_COLORS.success}>+{line.content}</Text>
              </Box>
            );
          case "del":
            return (
              <Box key={line.key}>
                <Text dimColor>{gutter} </Text>
                <Text color={STATUS_COLORS.error}>-{line.content}</Text>
              </Box>
            );
          case "hunk":
            return (
              <Box key={line.key}>
                <Text dimColor>{gutter} </Text>
                <Text color={STATUS_COLORS.info}>{line.content}</Text>
              </Box>
            );
          case "header":
            return (
              <Box key={line.key}>
                <Text dimColor>
                  {gutter} {line.content}
                </Text>
              </Box>
            );
          default:
            return (
              <Box key={line.key}>
                <Text dimColor>
                  {gutter} {line.content}
                </Text>
              </Box>
            );
        }
      })}
    </Box>
  );
}

function truncateFilePath(file: string): string {
  const width = process.stdout.columns ?? 80;
  const maxLength = Math.max(0, width - 20);

  if (file.length <= maxLength) {
    return file;
  }

  if (maxLength <= 1) {
    return "…".slice(0, maxLength);
  }

  return `${file.slice(0, maxLength - 1)}…`;
}
