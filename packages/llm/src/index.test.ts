import type {
  LLMCompletionOptions,
  LLMMessage,
  LLMProvider,
} from "@iquantum/types";
import { APIError } from "openai";
import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  LLMRouter,
  OpenAICompatibleProvider,
  TokenBudgetExceededError,
  type TokenUsage,
} from "./index";

describe("AnthropicProvider", () => {
  it("maps system messages to the top-level system field and streams text deltas", async () => {
    const requests: unknown[] = [];
    const provider = new AnthropicProvider({
      client: {
        messages: {
          async countTokens(request: unknown) {
            requests.push(request);
            return { input_tokens: 12 };
          },
          stream(request: unknown) {
            requests.push(request);
            return asyncIterable([
              {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "hello" },
              },
              {
                type: "content_block_delta",
                delta: { type: "input_json_delta", partial_json: "{}" },
              },
            ]);
          },
        },
      } as never,
    });
    const messages = [
      { role: "system", content: "Be precise." },
      { role: "user", content: "Hi" },
    ] satisfies LLMMessage[];

    await expect(provider.countTokens(messages, "claude-model")).resolves.toBe(
      12,
    );
    await expect(
      collect(provider.complete(messages, baseOptions)),
    ).resolves.toBe("hello");
    expect(requests).toEqual([
      {
        model: "claude-model",
        messages: [{ role: "user", content: "Hi" }],
        system: "Be precise.",
      },
      {
        model: "claude-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "Hi" }],
        system: "Be precise.",
      },
    ]);
  });
});

describe("OpenAICompatibleProvider", () => {
  it("streams chat completion deltas", async () => {
    const provider = new OpenAICompatibleProvider({
      client: {
        chat: {
          completions: {
            async create() {
              return asyncIterable([
                { choices: [{ delta: { content: "hel" } }] },
                { choices: [{ delta: { content: "lo" } }] },
              ]);
            },
          },
        },
      } as never,
    });

    await expect(
      collect(
        provider.complete([{ role: "user", content: "Hi" }], baseOptions),
      ),
    ).resolves.toBe("hello");
  });

  it("retries retryable failures with exponential backoff", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const provider = new OpenAICompatibleProvider({
      client: {
        chat: {
          completions: {
            async create() {
              attempts += 1;

              if (attempts < 3) {
                throw new APIError(429, {}, "rate limited", new Headers());
              }

              return asyncIterable([
                { choices: [{ delta: { content: "ok" } }] },
              ]);
            },
          },
        },
      } as never,
      maxRetries: 3,
      baseDelayMs: 10,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await expect(
      collect(
        provider.complete([{ role: "user", content: "Hi" }], baseOptions),
      ),
    ).resolves.toBe("ok");
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 20]);
  });
});

describe("LLMRouter", () => {
  it("routes plan to architect and implement to editor while recording usage", async () => {
    const architect = new MockProvider("plan-token", 5);
    const editor = new MockProvider("edit-token", 7);
    const usages: TokenUsage[] = [];
    const router = new LLMRouter({
      architect: { provider: architect, model: "architect-model" },
      editor: { provider: editor, model: "editor-model" },
      maxInputTokens: 100,
      usageSink: {
        async record(usage) {
          usages.push(usage);
        },
      },
    });

    await expect(
      collect(
        router.complete("plan", [{ role: "user", content: "Plan" }], {
          maxTokens: 10,
        }),
      ),
    ).resolves.toBe("plan-token");
    await expect(
      collect(
        router.complete("implement", [{ role: "user", content: "Edit" }], {
          maxTokens: 10,
        }),
      ),
    ).resolves.toBe("edit-token");

    expect(architect.calls).toEqual(["architect-model"]);
    expect(editor.calls).toEqual(["editor-model"]);
    expect(usages).toEqual([
      { phase: "plan", model: "architect-model", inputTokens: 5 },
      { phase: "implement", model: "editor-model", inputTokens: 7 },
    ]);
  });

  it("rejects prompts that exceed the configured token ceiling", async () => {
    const provider = new MockProvider("unused", 101);
    const router = new LLMRouter({
      architect: { provider, model: "architect-model" },
      editor: { provider, model: "editor-model" },
      maxInputTokens: 100,
    });

    await expect(async () => {
      for await (const _ of router.complete(
        "plan",
        [{ role: "user", content: "Too much" }],
        { maxTokens: 10 },
      )) {
        // Exhaust the stream to surface async generator errors.
      }
    }).rejects.toBeInstanceOf(TokenBudgetExceededError);
    expect(provider.calls).toEqual([]);
  });
});

const baseOptions = {
  model: "claude-model",
  maxTokens: 32,
} satisfies LLMCompletionOptions;

class MockProvider implements LLMProvider {
  readonly calls: string[] = [];

  constructor(
    readonly token: string,
    readonly tokenCount: number,
  ) {}

  async *complete(
    _messages: LLMMessage[],
    options: LLMCompletionOptions,
  ): AsyncIterable<string> {
    this.calls.push(options.model);
    yield this.token;
  }

  async countTokens(_messages: LLMMessage[], _model: string): Promise<number> {
    return this.tokenCount;
  }
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let output = "";

  for await (const token of stream) {
    output += token;
  }

  return output;
}

function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}
