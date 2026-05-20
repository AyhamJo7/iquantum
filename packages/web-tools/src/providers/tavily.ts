import {
  type SearchProvider,
  SearchProviderError,
  type SearchResult,
} from "../search";

interface TavilySearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
}

export class TavilySearchClient implements SearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string, count: number): Promise<SearchResult[]> {
    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          max_results: count,
          api_key: this.apiKey,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new SearchProviderError(
          `Tavily search failed with HTTP ${response.status}`,
        );
      }

      const body = (await response.json()) as TavilySearchResponse;
      return (body.results ?? []).map((result) => ({
        title: result.title ?? "",
        url: result.url ?? "",
        snippet: result.content ?? "",
      }));
    } catch (error) {
      if (error instanceof SearchProviderError) throw error;
      throw new SearchProviderError("Tavily search request failed", error);
    }
  }
}
