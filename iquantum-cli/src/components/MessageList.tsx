import { Box, Text } from "ink";
import { memo } from "react";
import type { TranscriptItem } from "../screens/repl-state";
import { CommitCard } from "./CommitCard";
import { ErrorCard } from "./ErrorCard";
import { renderMarkdownToAnsi } from "./markdown";
import { StructuredDiff } from "./StructuredDiff";
import { ThinkingBlock } from "./ThinkingBlock";
import { COPY } from "./theme";

export interface MessageListProps {
  items: TranscriptItem[];
  streamingText?: string;
  thinkingText?: string;
  thinkingExpanded: boolean;
  thinkingStreaming?: boolean;
}

export function MessageList({
  items,
  streamingText = "",
  thinkingText = "",
  thinkingExpanded,
  thinkingStreaming = false,
}: MessageListProps) {
  return (
    <Box flexDirection="column" minHeight={1}>
      {items.map((item) => (
        <TranscriptRow
          key={item.id}
          item={item}
          thinkingExpanded={thinkingExpanded}
          thinkingStreaming={thinkingStreaming}
        />
      ))}
      {thinkingText || streamingText ? (
        <AssistantMessage
          text={streamingText}
          thinking={thinkingText}
          thinkingExpanded={thinkingExpanded}
          thinkingStreaming={thinkingStreaming}
        />
      ) : null}
    </Box>
  );
}

const TranscriptRow = memo(function TranscriptRow({
  item,
  thinkingExpanded,
  thinkingStreaming,
}: {
  item: TranscriptItem;
  thinkingExpanded: boolean;
  thinkingStreaming: boolean;
}) {
  if (item.type === "session_separator") {
    return <Text dimColor>──────────── {COPY.resumed} ────────────</Text>;
  }

  if (item.type === "compact_boundary") {
    return <Text dimColor>──────────── {COPY.compacted} ────────────</Text>;
  }

  if (item.type === "diff_preview") {
    return (
      <StructuredDiff
        file={item.file}
        patch={item.patch}
        addCount={item.addCount}
        delCount={item.delCount}
      />
    );
  }

  if (item.type === "checkpoint") {
    return <CommitCard hash={item.hash} message={item.message} />;
  }

  if (item.type === "system_message") {
    if (item.level === "error") {
      return <ErrorCard message={item.text} />;
    }

    return (
      <Text color="cyan" dimColor>
        {item.text}
      </Text>
    );
  }

  if (item.type === "permission_request") {
    if (!item.resolved) {
      return null;
    }

    return (
      <Text dimColor>
        {item.approved ? "✓" : "✗"} tool {item.tool}{" "}
        {item.approved ? "approved" : "denied"}
      </Text>
    );
  }

  if (item.role === "user") {
    return <UserMessage text={item.text} />;
  }

  return (
    <AssistantMessage
      text={item.text}
      {...(item.thinking ? { thinking: item.thinking } : {})}
      thinkingExpanded={thinkingExpanded}
      thinkingStreaming={thinkingStreaming}
    />
  );
});

const UserMessage = memo(function UserMessage({ text }: { text: string }) {
  const cols = process.stdout.columns ?? 80;
  const content = `  > ${text}  `;
  const padded = content.length < cols ? content.padEnd(cols) : content;
  return (
    <Text backgroundColor="green" color="black" bold>
      {padded}
    </Text>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  text,
  thinking,
  thinkingExpanded,
  thinkingStreaming,
}: {
  text: string;
  thinking?: string;
  thinkingExpanded: boolean;
  thinkingStreaming: boolean;
}) {
  return (
    <Box flexDirection="column">
      {thinking ? (
        <ThinkingBlock
          text={thinking}
          expanded={thinkingExpanded}
          isStreaming={thinkingStreaming}
        />
      ) : null}
      {text ? <Text>{renderMarkdownToAnsi(text)}</Text> : null}
    </Box>
  );
});
