import type { TranscriptItem } from "@iquantum/ui-core";
import { describe, expect, it } from "vitest";
import { visibleTranscriptWindow } from "./virtual-transcript";

describe("visibleTranscriptWindow", () => {
  it("keeps the newest transcript rows visible", () => {
    const items: TranscriptItem[] = [message("1"), message("2"), message("3")];

    expect(visibleTranscriptWindow(items, 2).map((item) => item.id)).toEqual([
      "2",
      "3",
    ]);
  });
});

function message(id: string): TranscriptItem {
  return {
    id,
    type: "message",
    role: "assistant",
    text: id,
  };
}
