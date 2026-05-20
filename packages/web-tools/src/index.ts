import type { BuiltinTool } from "@iquantum/llm";
import { BraveSearchClient } from "./providers/brave";
import { TavilySearchClient } from "./providers/tavily";
import type { SearchProvider } from "./search";
import { WebFetchTool } from "./tools/web-fetch";
import { DisabledSearchProvider, WebSearchTool } from "./tools/web-search";

export { BraveSearchClient } from "./providers/brave";
export { TavilySearchClient } from "./providers/tavily";
export {
  type SearchProvider,
  SearchProviderError,
  type SearchResult,
} from "./search";
export {
  assertNotSsrf,
  isPrivateIp,
  SsrfBlockedError,
} from "./ssrf-guard";
export { WebFetchTool } from "./tools/web-fetch";
export { DisabledSearchProvider, WebSearchTool } from "./tools/web-search";

export interface WebTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  execute(input: unknown): Promise<string>;
}

export interface WebToolRateLimiter {
  consume(
    key: string,
    options: { limit: number; windowMs: number },
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
}

export const WEB_TOOL_RATE_LIMITS = {
  webSearchPerMin: { limit: 10, windowMs: 60_000 },
} as const;

export interface WebToolExecutorConfig {
  enabled: boolean;
  provider: "brave" | "tavily" | "none";
  braveApiKey?: string;
  tavilyApiKey?: string;
}

export class WebToolExecutor {
  readonly #tools: WebTool[];

  constructor(config: WebToolExecutorConfig) {
    if (!config.enabled) {
      this.#tools = [];
      return;
    }

    const provider = createSearchProvider(config);
    this.#tools = [new WebFetchTool(), new WebSearchTool(provider)];
  }

  getAll(): WebTool[] {
    return [...this.#tools];
  }
}

function createSearchProvider(config: WebToolExecutorConfig): SearchProvider {
  if (config.provider === "brave" && config.braveApiKey) {
    return new BraveSearchClient(config.braveApiKey);
  }

  if (config.provider === "tavily" && config.tavilyApiKey) {
    return new TavilySearchClient(config.tavilyApiKey);
  }

  return new DisabledSearchProvider();
}

export function createWebToolBuiltins(
  webTools: WebToolExecutor,
  rateLimitKey: string,
  rateLimiter: WebToolRateLimiter | undefined,
): BuiltinTool[] {
  return webTools
    .getAll()
    .map((tool) => webToolToBuiltinTool(tool, rateLimitKey, rateLimiter));
}

function webToolToBuiltinTool(
  tool: WebTool,
  rateLimitKey: string,
  rateLimiter: WebToolRateLimiter | undefined,
): BuiltinTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    async execute(args) {
      if (tool.name === "web_search" && rateLimiter) {
        const result = await rateLimiter.consume(
          `web_search:${rateLimitKey}`,
          WEB_TOOL_RATE_LIMITS.webSearchPerMin,
        );

        if (!result.allowed) {
          return "Error: web_search rate limit exceeded.";
        }
      }

      return tool.execute(args);
    },
  };
}
