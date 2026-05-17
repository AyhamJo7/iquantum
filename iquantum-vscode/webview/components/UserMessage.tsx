export function UserMessage({ text }: { text: string }) {
  return (
    <div
      style={{ background: "#333", color: "#fff", padding: 8, borderRadius: 6 }}
    >
      {text}
    </div>
  );
}
