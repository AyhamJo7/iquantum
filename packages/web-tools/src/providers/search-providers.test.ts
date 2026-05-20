import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchProviderError } from "../search";
import { BraveSearchClient } from "./brave";
import { TavilySearchClient } from "./tavily";

describe("search providers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("queries Brave and maps web results", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        web: {
          results: [
            { title: "One", url: "https://one.test", description: "first" },
            { title: "Two", url: "https://two.test", description: "second" },
            {
              title: "Three",
              url: "https://three.test",
              description: "third",
            },
          ],
        },
      }),
    );

    const results = await new BraveSearchClient("brave-key").search(
      "bun latest",
      3,
    );

    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      "q=bun+latest",
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": "brave-key",
      },
      signal: expect.any(AbortSignal),
    });
    expect(results).toEqual([
      { title: "One", url: "https://one.test", snippet: "first" },
      { title: "Two", url: "https://two.test", snippet: "second" },
      { title: "Three", url: "https://three.test", snippet: "third" },
    ]);
  });

  it("wraps Brave HTTP failures in SearchProviderError", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: "denied" }, { status: 401 }),
    );

    await expect(
      new BraveSearchClient("brave-key").search("bun latest", 3),
    ).rejects.toThrow(SearchProviderError);
    await expect(
      new BraveSearchClient("brave-key").search("bun latest", 3),
    ).rejects.toThrow("Brave search failed with HTTP 401");
  });

  it("wraps Brave transport failures in SearchProviderError", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    await expect(
      new BraveSearchClient("brave-key").search("bun latest", 3),
    ).rejects.toThrow(SearchProviderError);
    await expect(
      new BraveSearchClient("brave-key").search("bun latest", 3),
    ).rejects.toThrow("Brave search request failed");
  });

  it("queries Tavily and maps results", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        results: [
          { title: "One", url: "https://one.test", content: "first" },
          { title: "Two", url: "https://two.test", content: "second" },
        ],
      }),
    );

    const results = await new TavilySearchClient("tavily-key").search(
      "bun latest",
      2,
    );

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "https://api.tavily.com/search",
    );
    expect(
      JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)),
    ).toEqual({
      query: "bun latest",
      max_results: 2,
      api_key: "tavily-key",
    });
    expect(results).toEqual([
      { title: "One", url: "https://one.test", snippet: "first" },
      { title: "Two", url: "https://two.test", snippet: "second" },
    ]);
  });

  it("wraps Tavily HTTP failures in SearchProviderError", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: "denied" }, { status: 403 }),
    );

    await expect(
      new TavilySearchClient("tavily-key").search("bun latest", 2),
    ).rejects.toThrow(SearchProviderError);
    await expect(
      new TavilySearchClient("tavily-key").search("bun latest", 2),
    ).rejects.toThrow("Tavily search failed with HTTP 403");
  });

  it("wraps Tavily transport failures in SearchProviderError", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    await expect(
      new TavilySearchClient("tavily-key").search("bun latest", 2),
    ).rejects.toThrow(SearchProviderError);
    await expect(
      new TavilySearchClient("tavily-key").search("bun latest", 2),
    ).rejects.toThrow("Tavily search request failed");
  });
});
