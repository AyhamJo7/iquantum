import { Box, Text } from "ink";
import { parseDiffLines } from "./diff-parser";

export interface StructuredDiffProps {
  file: string;
  patch: string;
}

export function StructuredDiff({ file, patch }: StructuredDiffProps) {
  const lines = parseDiffLines(patch);
  const keyed = lines.map((line, i) => ({
    ...line,
    key: `${file}:${i}:${line.type}`,
  }));

  return (
    <Box flexDirection="column" marginY={1}>
      <Text dimColor>── {file} ──</Text>
      {keyed.map((line) => {
        switch (line.type) {
          case "add":
            return (
              <Text key={line.key} color="green">
                +{line.content}
              </Text>
            );
          case "del":
            return (
              <Text key={line.key} color="red">
                -{line.content}
              </Text>
            );
          case "hunk":
            return (
              <Text key={line.key} color="cyan">
                {line.content}
              </Text>
            );
          case "header":
            return (
              <Text key={line.key} dimColor>
                {line.content}
              </Text>
            );
          default:
            return (
              <Text key={line.key} dimColor>
                {" "}
                {line.content}
              </Text>
            );
        }
      })}
    </Box>
  );
}
