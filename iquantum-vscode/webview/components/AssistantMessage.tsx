import { marked } from "marked";
import { useMemo } from "react";

export function AssistantMessage({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text) as string, [text]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: daemon-produced markdown is rendered intentionally in the trusted webview.
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
