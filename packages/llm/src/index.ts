import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionEvent,
  LLMCompletionOptions,
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  McpTool,
  PIVPhase,
} from "@iquantum/types";
import OpenAI, { APIError } from "openai";

export interface AnthropicProviderOptions {
  client?: AnthropicClient;
  apiKey?: string;
}

export interface OpenAICompatibleProviderOptions {
  client?: OpenAIClient;
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface LLMRoute {
  provider: LLMProvider;
  model: string;
}

export interface LLMRouterOptions {
  architect: LLMRoute;
  editor: LLMRoute;
  maxInputTokens: number;
  usageSink?: TokenUsageSink;
}

export interface RoutedCompletionOptions {
  maxTokens: number;
  temperature?: number;
}

export interface TokenUsage {
  phase: PIVPhase;
  model: string;
  inputTokens: number;
}

export interface TokenUsageSink {
  record(usage: TokenUsage): Promise<void>;
}

export class TokenBudgetExceededError extends Error {
  constructor(
    readonly tokenCount: number,
    readonly maxInputTokens: number,
  ) {
    super(`Token budget exceeded: ${tokenCount} > ${maxInputTokens}`);
    this.name = "TokenBudgetExceededError";
  }
}

const LLM_REQUEST_TIMEOUT_MS = 120_000;

export class AnthropicProvider implements LLMProvider {
  readonly #client: AnthropicClient;

  constructor(options: AnthropicProviderOptions = {}) {
    this.#client =
      options.client ??
      (new Anthropic({
        apiKey: options.apiKey,
        timeout: LLM_REQUEST_TIMEOUT_MS,
      }) satisfies AnthropicClient);
  }

  async *complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions,
  ): AsyncIterable<string> {
    const { messages: anthropicMessages, system } =
      toAnthropicMessages(messages);
    const stream = this.#client.messages.stream({
      model: options.model,
      max_tokens: options.maxTokens,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
  }

  async *completeWithTools(
    messages: LLMMessage[],
    tools: readonly McpTool[],
    options: LLMCompletionOptions,
  ): AsyncIterable<CompletionEvent> {
    const { messages: anthropicMessages, system } =
      toAnthropicMessages(messages);
    const stream = this.#client.messages.stream({
      model: options.model,
      max_tokens: options.maxTokens,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema:
          t.inputSchema as unknown as Anthropic.Messages.Tool.InputSchema,
      })),
    });

    let pendingId: string | null = null;
    let pendingName: string | null = null;
    let pendingJson = "";

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          pendingId = event.content_block.id;
          pendingName = event.content_block.name;
          pendingJson = "";
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "token", delta: event.delta.text };
        } else if (event.delta.type === "input_json_delta") {
          pendingJson += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        if (pendingId && pendingName) {
          yield {
            type: "tool_use",
            id: pendingId,
            name: pendingName,
            input: JSON.parse(pendingJson || "{}") as Record<string, unknown>,
          };
          pendingId = null;
          pendingName = null;
          pendingJson = "";
        }
      }
    }
  }

  async countTokens(messages: LLMMessage[], model: string): Promise<number> {
    const { messages: anthropicMessages, system } =
      toAnthropicMessages(messages);
    const response = await this.#client.messages.countTokens({
      model,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
    });

    return response.input_tokens;
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly #client: OpenAIClient;
  readonly #maxRetries: number;
  readonly #baseDelayMs: number;
  readonly #sleep: (delayMs: number) => Promise<void>;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.#client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        timeout: options.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS,
      });
    this.#maxRetries = options.maxRetries ?? 3;
    this.#baseDelayMs = options.baseDelayMs ?? 250;
    this.#sleep = options.sleep ?? sleep;
  }

  async *complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions,
  ): AsyncIterable<string> {
    const stream = await this.#withRetry(() =>
      this.#client.chat.completions.create({
        model: options.model,
        max_tokens: options.maxTokens,
        messages: messages.map(toOpenAIMessage),
        stream: true,
        stream_options: { include_usage: true },
        ...(options.temperature === undefined
          ? {}
          : { temperature: options.temperature }),
      }),
    );

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.content;

      if (delta) {
        yield delta;
      }
    }
  }

  async countTokens(messages: LLMMessage[], _model: string): Promise<number> {
    return roughTokenCount(
      messages
        .map((message) => `${message.role}:${contentToString(message.content)}`)
        .join("\n"),
    );
  }

  async #withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableOpenAIError(error) || attempt >= this.#maxRetries) {
          throw error;
        }

        const delayMs = this.#baseDelayMs * 2 ** attempt;
        attempt += 1;
        await this.#sleep(delayMs);
      }
    }
  }
}

export class LLMRouter {
  readonly #architect: LLMRoute;
  readonly #editor: LLMRoute;
  readonly #maxInputTokens: number;
  readonly #usageSink: TokenUsageSink | undefined;

  constructor(options: LLMRouterOptions) {
    this.#architect = options.architect;
    this.#editor = options.editor;
    this.#maxInputTokens = options.maxInputTokens;
    this.#usageSink = options.usageSink;
  }

  async *complete(
    phase: PIVPhase,
    messages: LLMMessage[],
    options: RoutedCompletionOptions,
  ): AsyncIterable<string> {
    const route = this.#routeForPhase(phase);
    const inputTokens = await route.provider.countTokens(messages, route.model);

    if (inputTokens > this.#maxInputTokens) {
      throw new TokenBudgetExceededError(inputTokens, this.#maxInputTokens);
    }

    await this.#usageSink?.record({
      phase,
      model: route.model,
      inputTokens,
    });

    yield* route.provider.complete(messages, {
      model: route.model,
      maxTokens: options.maxTokens,
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
    });
  }

  async *completeWithTools(
    phase: PIVPhase,
    messages: LLMMessage[],
    tools: readonly McpTool[],
    options: RoutedCompletionOptions,
  ): AsyncIterable<CompletionEvent> {
    const route = this.#routeForPhase(phase);

    if (!route.provider.completeWithTools) {
      throw new Error(
        `Provider for model ${route.model} does not support tool use`,
      );
    }

    const inputTokens = await route.provider.countTokens(messages, route.model);

    if (inputTokens > this.#maxInputTokens) {
      throw new TokenBudgetExceededError(inputTokens, this.#maxInputTokens);
    }

    await this.#usageSink?.record({
      phase,
      model: route.model,
      inputTokens,
    });

    yield* route.provider.completeWithTools(messages, tools, {
      model: route.model,
      maxTokens: options.maxTokens,
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
    });
  }

  #routeForPhase(phase: PIVPhase): LLMRoute {
    if (phase === "plan") {
      return this.#architect;
    }

    return this.#editor;
  }
}

type AnthropicClient = Pick<Anthropic, "messages">;
type OpenAIClient = Pick<OpenAI, "chat">;

function contentToString(content: string | LLMContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

function toAnthropicMessages(messages: LLMMessage[]): {
  messages: Anthropic.Messages.MessageParam[];
  system?: string;
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => contentToString(message.content))
    .join("\n\n");
  const mappedMessages = messages
    .filter(
      (message): message is LLMMessage & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role,
      content: message.content as
        | string
        | Anthropic.Messages.ContentBlockParam[],
    }));

  return {
    messages: mappedMessages,
    ...(system ? { system } : {}),
  };
}

function toOpenAIMessage(
  message: LLMMessage,
): OpenAI.Chat.ChatCompletionMessageParam {
  return {
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
  } as OpenAI.Chat.ChatCompletionMessageParam;
}

function isRetryableOpenAIError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    (error.status === 408 ||
      error.status === 409 ||
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500))
  );
}

function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}
