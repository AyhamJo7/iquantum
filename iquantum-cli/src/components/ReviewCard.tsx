import { Box, Text } from "ink";
import type { ReviewFinding } from "../client";
import { colorForSeverity } from "./review-card-format";

export interface ReviewCardProps {
  finding: ReviewFinding;
}

export function ReviewCard({ finding }: ReviewCardProps) {
  const location =
    finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  const color = colorForSeverity(finding.severity);

  return (
    <Box
      flexDirection="column"
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor={color}
      paddingLeft={1}
      marginY={1}
    >
      <Text color={color} bold>
        {finding.severity.toUpperCase()} {finding.title}
      </Text>
      <Text dimColor>{location}</Text>
      <Text>{finding.description}</Text>
      <Text dimColor>Suggestion: {finding.suggestion}</Text>
    </Box>
  );
}
