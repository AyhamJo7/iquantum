import type { TranscriptItem } from "@iquantum/ui-core";
import { useEffect, useRef } from "react";
import { AssistantMessage } from "./AssistantMessage";
import { ThinkingBlock } from "./ThinkingBlock";
import { UserMessage } from "./UserMessage";

export function MessageList({
  items,
  streamingText,
  thinkingText,
}: {
  items: TranscriptItem[];
  streamingText: string;
  thinkingText: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));
  return (
    <div className="messages">
      {items.map((item) => {
        if (item.type !== "message")
          return <div key={item.id}>{item.type}</div>;
        return item.role === "user" ? (
          <UserMessage key={item.id} text={item.text} />
        ) : (
          <div key={item.id}>
            {item.thinking ? <ThinkingBlock text={item.thinking} /> : null}
            <AssistantMessage text={item.text} />
          </div>
        );
      })}
      {thinkingText ? <ThinkingBlock text={thinkingText} /> : null}
      {streamingText ? <AssistantMessage text={streamingText} /> : null}
      <div ref={endRef} />
    </div>
  );
}
