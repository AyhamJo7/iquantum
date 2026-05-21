import type {
  LLMCompletionOptions,
  LLMMessage,
  LLMProvider,
} from "@iquantum/types";
import { APIError } from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AnthropicProvider,
  ContextBudgetGuard,
  createFileToolBuiltins,
  LLMRouter,
  OpenAICompatibleProvider,
  StructuredOutputParseError,
  StructuredOutputRouter,
  TokenBudgetExceededError,
  type TokenUsage,
  ToolLoopExceededError,
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

  it("streams OpenAI-compatible tool calls", async () => {
    const requests: unknown[] = [];
    const provider = new OpenAICompatibleProvider({
      client: {
        chat: {
          completions: {
            async create(request: unknown) {
              requests.push(request);
              return asyncIterable([
                { choices: [{ delta: { content: "Checking" } }] },
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call-1",
                            function: {
                              name: "file_read",
                              arguments: '{"path"',
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            function: { arguments: ':"src/index.ts"}' },
                          },
                        ],
                      },
                    },
                  ],
                },
              ]);
            },
          },
        },
      } as never,
    });

    const events = await collectEvents(
      provider.completeWithTools?.(
        [{ role: "user", content: "Read a file" }],
        [
          {
            name: "file_read",
            description: "read",
            inputSchema: { type: "object" },
          },
        ],
        baseOptions,
      ) ?? asyncIterable([]),
    );

    expect(events).toEqual([
      { type: "token", delta: "Checking" },
      {
        type: "tool_use",
        id: "call-1",
        name: "file_read",
        input: { path: "src/index.ts" },
      },
    ]);
    expect(requests).toEqual([
      expect.objectContaining({
        tools: [
          {
            type: "function",
            function: {
              name: "file_read",
              description: "read",
              parameters: { type: "object" },
            },
          },
        ],
      }),
    ]);
  });

  it("uses empty input for malformed OpenAI-compatible tool arguments", async () => {
    const provider = new OpenAICompatibleProvider({
      client: {
        chat: {
          completions: {
            async create() {
              return asyncIterable([
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call-1",
                            function: {
                              name: "file_read",
                              arguments: '{"path"',
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              ]);
            },
          },
        },
      } as never,
    });

    const events = await collectEvents(
      provider.completeWithTools?.(
        [{ role: "user", content: "Read a file" }],
        [
          {
            name: "file_read",
            description: "read",
            inputSchema: { type: "object" },
          },
        ],
        baseOptions,
      ) ?? asyncIterable([]),
    );

    expect(events).toEqual([
      {
        type: "tool_use",
        id: "call-1",
        name: "file_read",
        input: {},
      },
    ]);
  });

  it("uses the documented rough token estimate", async () => {
    const provider = new OpenAICompatibleProvider({ apiKey: "test-key" });

    await expect(
      provider.countTokens([{ role: "user", content: "12345678" }], "model"),
    ).resolves.toBe(4);
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

    await expect(
      (async () => {
        for await (const _ of router.complete(
          "plan",
          [{ role: "user", content: "Too much" }],
          { maxTokens: 10 },
        )) {
          // Exhaust the stream to surface async generator errors.
        }
      })(),
    ).rejects.toBeInstanceOf(TokenBudgetExceededError);
    expect(provider.calls).toEqual([]);
  });

  it("routes effort levels: fast→editor, normal→architect, thorough→architect by default", async () => {
    const architect = new MockProvider("arch-token", 5);
    const editor = new MockProvider("edit-token", 3);
    const router = new LLMRouter({
      architect: { provider: architect, model: "architect-model" },
      editor: { provider: editor, model: "editor-model" },
      maxInputTokens: 100,
    });

    const msg = [{ role: "user" as const, content: "test" }];
    await collect(router.completeWithEffort("fast", msg, { maxTokens: 10 }));
    await collect(router.completeWithEffort("normal", msg, { maxTokens: 10 }));
    await collect(
      router.completeWithEffort("thorough", msg, { maxTokens: 10 }),
    );

    expect(editor.calls).toEqual(["editor-model"]);
    expect(architect.calls).toEqual(["architect-model", "architect-model"]);
  });

  it("routes tool streams through the selected provider", async () => {
    const architect = new MockToolProvider("arch", 5);
    const editor = new MockToolProvider("edit", 3);
    const router = new LLMRouter({
      architect: { provider: architect, model: "architect-model" },
      editor: { provider: editor, model: "editor-model" },
      maxInputTokens: 100,
    });

    const events = await collectEvents(
      router.completeWithTools(
        "implement",
        [{ role: "user", content: "use tool" }],
        [
          {
            name: "file_read",
            description: "read",
            inputSchema: { type: "object" },
          },
        ],
        { maxTokens: 10 },
      ),
    );

    expect(events).toEqual([{ type: "token", delta: "edit" }]);
    expect(editor.toolCalls).toEqual([
      { model: "editor-model", tools: ["file_read"] },
    ]);
    expect(architect.toolCalls).toEqual([]);
  });

  it("routes thorough to a dedicated thorough model when configured", async () => {
    const thorough = new MockProvider("thorough-token", 5);
    const architect = new MockProvider("arch-token", 5);
    const editor = new MockProvider("edit-token", 3);
    const router = new LLMRouter({
      architect: { provider: architect, model: "architect-model" },
      editor: { provider: editor, model: "editor-model" },
      thorough: { provider: thorough, model: "thorough-model" },
      maxInputTokens: 100,
    });

    const msg = [{ role: "user" as const, content: "test" }];
    const result = await collect(
      router.completeWithEffort("thorough", msg, { maxTokens: 10 }),
    );

    expect(result).toBe("thorough-token");
    expect(thorough.calls).toEqual(["thorough-model"]);
    expect(architect.calls).toEqual([]);
  });

  it("defaults to thinking support and allows providers to disable it", () => {
    const provider = new MockProvider("unused", 1);
    const defaultRouter = new LLMRouter({
      architect: { provider, model: "architect-model" },
      editor: { provider, model: "editor-model" },
      maxInputTokens: 100,
    });
    const openaiRouter = new LLMRouter({
      architect: { provider, model: "architect-model" },
      editor: { provider, model: "editor-model" },
      maxInputTokens: 100,
      supportsThinking: false,
    });

    expect(defaultRouter.supportsThinking).toBe(true);
    expect(openaiRouter.supportsThinking).toBe(false);
  });

  it("warns near the context limit and compacts before hard failure", async () => {
    const warnings: number[] = [];
    const provider = new MockProvider("ok", 96);
    const router = new LLMRouter({
      architect: { provider, model: "architect-model" },
      editor: { provider, model: "editor-model" },
      maxInputTokens: 100,
      budgetGuard: new ContextBudgetGuard({
        warnThreshold: 0.8,
        hardThreshold: 0.95,
        onWarn(request) {
          warnings.push(request.inputTokens);
        },
        async forceCompact() {
          return [{ role: "user", content: "small" }];
        },
        async countTokens(messages) {
          return messages[0]?.content === "small" ? 5 : 96;
        },
      }),
    });

    await expect(
      collect(
        router.complete("plan", [{ role: "user", content: "large" }], {
          maxTokens: 10,
        }),
      ),
    ).resolves.toBe("ok");

    expect(warnings).toEqual([96]);
    expect(provider.seenMessages).toEqual([
      [{ role: "user", content: "small" }],
    ]);
  });
});

describe("StructuredOutputRouter", () => {
  it("parses fenced JSON through the provided schema", async () => {
    const router = new StructuredOutputRouter({
      async *complete() {
        yield '```json\n{"summary":"ok","count":1}\n```';
      },
    });

    await expect(
      router.completeStructured(
        [{ role: "user", content: "respond json" }],
        z.object({ summary: z.string(), count: z.number() }),
        { maxTokens: 100 },
      ),
    ).resolves.toEqual({ summary: "ok", count: 1 });
  });

  it("throws a typed parse error for schema mismatches", async () => {
    const router = new StructuredOutputRouter({
      async *complete() {
        yield '{"summary":1}';
      },
    });

    await expect(
      router.completeStructured(
        [{ role: "user", content: "respond json" }],
        z.object({ summary: z.string() }),
        { maxTokens: 100 },
      ),
    ).rejects.toBeInstanceOf(StructuredOutputParseError);
  });
});

describe("createFileToolBuiltins", () => {
  it("wraps sandbox file tools as executable builtin tools", async () => {
    const sandbox = {
      exec: async () => {
        throw new Error("not used");
      },
    };
    const fileTools = {
      getAll: () => [
        {
          name: "file_read",
          description: "read",
          inputSchema: { type: "object" },
          mutates: true,
          async execute(
            input: unknown,
            receivedSandbox: unknown,
            sessionId: string,
          ) {
            return JSON.stringify({ input, receivedSandbox, sessionId });
          },
        },
      ],
    };

    const [tool] = createFileToolBuiltins(
      fileTools as never,
      sandbox,
      "sess-1",
    );

    expect(tool?.name).toBe("file_read");
    expect(tool?.mutates).toBe(true);
    await expect(tool?.execute({ path: "a.ts" })).resolves.toBe(
      JSON.stringify({
        input: { path: "a.ts" },
        receivedSandbox: sandbox,
        sessionId: "sess-1",
      }),
    );
  });
});

describe("ToolLoopExceededError", () => {
  it("records the exceeded round count", () => {
    const error = new ToolLoopExceededError(11);

    expect(error.rounds).toBe(11);
    expect(error.message).toBe("Tool loop exceeded 11 rounds");
  });
});

const baseOptions = {
  model: "claude-model",
  maxTokens: 32,
} satisfies LLMCompletionOptions;

class MockProvider implements LLMProvider {
  readonly calls: string[] = [];
  readonly seenMessages: LLMMessage[][] = [];

  constructor(
    readonly token: string,
    readonly tokenCount: number,
  ) {}

  async *complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions,
  ): AsyncIterable<string> {
    this.calls.push(options.model);
    this.seenMessages.push(messages);
    yield this.token;
  }

  async countTokens(_messages: LLMMessage[], _model: string): Promise<number> {
    return this.tokenCount;
  }
}

class MockToolProvider extends MockProvider {
  readonly toolCalls: Array<{ model: string; tools: string[] }> = [];

  async *completeWithTools(
    _messages: LLMMessage[],
    tools: readonly { name: string }[],
    options: LLMCompletionOptions,
  ) {
    this.toolCalls.push({
      model: options.model,
      tools: tools.map((tool) => tool.name),
    });
    yield { type: "token" as const, delta: this.token };
  }
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let output = "";

  for await (const token of stream) {
    output += token;
  }

  return output;
}

async function collectEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];

  for await (const event of stream) {
    output.push(event);
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
