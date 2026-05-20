import {
  type SearchProvider,
  SearchProviderError,
  type SearchResult,
} from "../search";

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}

export class BraveSearchClient implements SearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string, count: number): Promise<SearchResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new SearchProviderError(
          `Brave search failed with HTTP ${response.status}`,
        );
      }

      const body = (await response.json()) as BraveSearchResponse;
      return (body.web?.results ?? []).map((result) => ({
        title: result.title ?? "",
        url: result.url ?? "",
        snippet: result.description ?? "",
      }));
    } catch (error) {
      if (error instanceof SearchProviderError) throw error;
      throw new SearchProviderError("Brave search request failed", error);
    }
  }
}
