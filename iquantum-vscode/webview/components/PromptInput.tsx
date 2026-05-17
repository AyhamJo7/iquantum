import { useState } from "react";
export function PromptInput({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit(content: string): void;
}) {
  const [value, setValue] = useState("");
  return (
    <textarea
      value={value}
      disabled={disabled}
      placeholder="Ask iquantum…"
      style={{ width: "100%", fieldSizing: "content" as never }}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const content = value.trim();
          if (content) onSubmit(content);
          setValue("");
        }
      }}
    />
  );
}
