import { describe, expect, it } from "vitest";
import { WebToolExecutor } from "./index";
import { BraveSearchClient } from "./providers/brave";
import { TavilySearchClient } from "./providers/tavily";
import { WebSearchTool } from "./tools/web-search";

describe("WebToolExecutor", () => {
  it("returns no tools when disabled", () => {
    const executor = new WebToolExecutor({
      enabled: false,
      provider: "brave",
      braveApiKey: "key",
    });

    expect(executor.getAll()).toEqual([]);
  });

  it("returns fetch and search tools when enabled", () => {
    const executor = new WebToolExecutor({
      enabled: true,
      provider: "none",
    });

    expect(executor.getAll().map((tool) => tool.name)).toEqual([
      "web_fetch",
      "web_search",
    ]);
  });

  it("uses BraveSearchClient when Brave provider is configured with a key", () => {
    const executor = new WebToolExecutor({
      enabled: true,
      provider: "brave",
      braveApiKey: "brave-key",
    });

    const searchTool = executor
      .getAll()
      .find((tool) => tool.name === "web_search");

    expect(searchTool).toBeInstanceOf(WebSearchTool);
    expect(searchTool).toHaveProperty(
      "provider",
      expect.any(BraveSearchClient),
    );
  });

  it("uses TavilySearchClient when Tavily provider is configured with a key", () => {
    const executor = new WebToolExecutor({
      enabled: true,
      provider: "tavily",
      tavilyApiKey: "tavily-key",
    });

    const searchTool = executor
      .getAll()
      .find((tool) => tool.name === "web_search");

    expect(searchTool).toBeInstanceOf(WebSearchTool);
    expect(searchTool).toHaveProperty(
      "provider",
      expect.any(TavilySearchClient),
    );
  });

  it("falls back to disabled search when Brave is configured without a Brave key", async () => {
    const executor = new WebToolExecutor({
      enabled: true,
      provider: "brave",
      tavilyApiKey: "tavily-key",
    });

    const searchTool = executor
      .getAll()
      .find((tool) => tool.name === "web_search");

    const result = await searchTool?.execute({ query: "test" });

    expect(result).toBe("Web search is not enabled");
  });
});
