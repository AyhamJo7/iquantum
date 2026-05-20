import { z } from "zod";
import type { WebTool } from "../index";
import type { SearchProvider } from "../search";

const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    count: { type: "number" },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const inputParser = z.object({
  query: z.string().min(1),
  count: z.number().int().min(1).optional().default(5),
});

export class WebSearchTool implements WebTool {
  readonly name = "web_search";
  readonly description =
    "Search the web for current information and return result titles, URLs, and snippets.";
  readonly inputSchema = inputSchema;

  constructor(private readonly provider: SearchProvider) {}

  async execute(input: unknown): Promise<string> {
    try {
      if (this.provider instanceof DisabledSearchProvider) {
        return "Web search is not enabled";
      }

      const parsed = inputParser.parse(input);
      const count = Math.min(parsed.count, 10);
      const results = await this.provider.search(parsed.query, count);

      if (results.length === 0) {
        return "No web search results found.";
      }

      return results
        .map(
          (result, index) =>
            `${index + 1}. ${result.title}\n   ${result.url}\n   ${
              result.snippet
            }`,
        )
        .join("\n\n");
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

export class DisabledSearchProvider implements SearchProvider {
  async search(): Promise<never> {
    throw new Error("Web search is not enabled");
  }
}
