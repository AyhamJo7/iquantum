import { Box, Text } from "ink";
import { memo } from "react";
import type { TranscriptItem } from "../screens/repl-state";
import { renderMarkdownToAnsi } from "./markdown";
import { ThinkingBlock } from "./ThinkingBlock";

export interface MessageListProps {
  items: TranscriptItem[];
  streamingText?: string;
  thinkingText?: string;
  thinkingExpanded: boolean;
}

export function MessageList({
  items,
  streamingText = "",
  thinkingText = "",
  thinkingExpanded,
}: MessageListProps) {
  return (
    <Box flexDirection="column" minHeight={1}>
      {items.map((item) => (
        <TranscriptRow
          key={item.id}
          item={item}
          thinkingExpanded={thinkingExpanded}
        />
      ))}
      {thinkingText || streamingText ? (
        <AssistantMessage
          text={streamingText}
          thinking={thinkingText}
          thinkingExpanded={thinkingExpanded}
        />
      ) : null}
    </Box>
  );
}

const TranscriptRow = memo(function TranscriptRow({
  item,
  thinkingExpanded,
}: {
  item: TranscriptItem;
  thinkingExpanded: boolean;
}) {
  if (item.type === "compact_boundary") {
    return <Text dimColor>──────────── context compacted ────────────</Text>;
  }

  if (item.role === "user") {
    return <UserMessage text={item.text} />;
  }

  return (
    <AssistantMessage
      text={item.text}
      {...(item.thinking ? { thinking: item.thinking } : {})}
      thinkingExpanded={thinkingExpanded}
    />
  );
});

const UserMessage = memo(function UserMessage({ text }: { text: string }) {
  return (
    <Box justifyContent="flex-end">
      <Text dimColor>you </Text>
      <Text>{text}</Text>
    </Box>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  text,
  thinking,
  thinkingExpanded,
}: {
  text: string;
  thinking?: string;
  thinkingExpanded: boolean;
}) {
  return (
    <Box flexDirection="column">
      {thinking ? (
        <ThinkingBlock text={thinking} expanded={thinkingExpanded} />
      ) : null}
      {text ? <Text>{renderMarkdownToAnsi(text)}</Text> : null}
    </Box>
  );
});
