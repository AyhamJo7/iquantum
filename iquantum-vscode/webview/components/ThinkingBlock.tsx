export function ThinkingBlock({ text }: { text: string }) {
  return (
    <details>
      <summary>∴ Thinking</summary>
      <pre>{text}</pre>
    </details>
  );
}
