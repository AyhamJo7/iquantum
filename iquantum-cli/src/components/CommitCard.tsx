import { Box, Text } from "ink";
import { shortCommitHash, truncateCommitMessage } from "./commit-card-format";
import { BORDERS, COPY, STATUS_COLORS } from "./theme";

export interface CommitCardProps {
  hash: string;
  message: string;
}

export function CommitCard({ hash, message }: CommitCardProps) {
  const width = process.stdout.columns ?? 80;

  return (
    <Box flexDirection="column" marginY={1} {...BORDERS.success}>
      <Text color={STATUS_COLORS.success}>{COPY.committed}</Text>
      <Text bold>✓ {shortCommitHash(hash)}</Text>
      <Text dimColor>{truncateCommitMessage(message, width)}</Text>
    </Box>
  );
}
