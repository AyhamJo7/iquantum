import { describe, expect, it, vi } from "vitest";
import { DisabledSearchProvider, WebSearchTool } from "./web-search";

describe("WebSearchTool", () => {
  it("formats provider results as a numbered markdown list", async () => {
    const provider = {
      search: vi.fn().mockResolvedValue([
        {
          title: "Bun release",
          url: "https://bun.sh/blog",
          snippet: "Latest Bun release notes",
        },
      ]),
    };

    const result = await new WebSearchTool(provider).execute({
      query: "latest bun",
      count: 20,
    });

    expect(provider.search).toHaveBeenCalledWith("latest bun", 10);
    expect(result).toBe(
      "1. Bun release\n   https://bun.sh/blog\n   Latest Bun release notes",
    );
  });

  it("returns disabled message when provider is none", async () => {
    const result = await new WebSearchTool(
      new DisabledSearchProvider(),
    ).execute({ query: "latest bun" });

    expect(result).toBe("Web search is not enabled");
  });
});
