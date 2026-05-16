import { countTokens } from "@iquantum/context-window";
import type {
  CompletionEvent,
  IMcpClient,
  LLMContentBlock,
  LLMMessage,
  McpTool,
} from "@iquantum/types";
import { messagesSinceLastBoundary } from "./conversation-history";
import type {
  ConversationContentBlock,
  ConversationMessage,
  ConversationPage,
  ConversationStore,
} from "./db/stores";

export interface ConversationCompleter {
  complete(
    messages: LLMMessage[],
    options: { maxTokens: number },
  ): AsyncIterable<string>;
  completeWithTools?(
    messages: LLMMessage[],
    tools: readonly McpTool[],
    options: { maxTokens: number },
  ): AsyncIterable<CompletionEvent>;
}

export interface ConversationStreams {
  publish(
    sessionId: string,
    frame:
      | { type: "phase_change"; phase: "requesting" | "thinking" }
      | { type: "token"; delta: string }
      | { type: "error"; message: string }
      | { type: "mcp_tool_call"; server: string; tool: string; input: unknown }
      | { type: "done" },
  ): void;
}

export interface ConversationCompactor {
  maybeCompact(sessionId: string): Promise<unknown>;
}

export interface PermissionChecker {
  requestPermission(
    sessionId: string,
    requestId: string,
    tool: string,
    input: unknown,
  ): Promise<boolean>;
}

export interface ConversationControllerOptions {
  store: ConversationStore;
  completer: ConversationCompleter;
  streams: ConversationStreams;
  compactor?: ConversationCompactor;
  mcpClient?: IMcpClient;
  permissionChecker?: PermissionChecker;
  maxResponseTokens?: number;
  maxToolTurns?: number;
  now?: () => string;
  createId?: () => string;
  tokenCounter?: typeof countTokens;
}

const MAX_TOOL_TURNS_DEFAULT = 10;

export class ConversationController {
  readonly #store: ConversationStore;
  readonly #completer: ConversationCompleter;
  readonly #streams: ConversationStreams;
  readonly #compactor: ConversationCompactor | undefined;
  readonly #mcpClient: IMcpClient | undefined;
  readonly #permissionChecker: PermissionChecker | undefined;
  readonly #maxResponseTokens: number;
  readonly #maxToolTurns: number;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #tokenCounter: typeof countTokens;
  #abortController: AbortController | null = null;

  constructor(options: ConversationControllerOptions) {
    this.#store = options.store;
    this.#completer = options.completer;
    this.#streams = options.streams;
    this.#compactor = options.compactor;
    this.#mcpClient = options.mcpClient;
    this.#permissionChecker = options.permissionChecker;
    this.#maxResponseTokens = options.maxResponseTokens ?? 2000;
    this.#maxToolTurns = options.maxToolTurns ?? MAX_TOOL_TURNS_DEFAULT;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#tokenCounter = options.tokenCounter ?? countTokens;
  }

  async addMessage(sessionId: string, content: string): Promise<void> {
    this.#abortController?.abort();
    const abortController = new AbortController();
    this.#abortController = abortController;

    await this.#compactor?.maybeCompact(sessionId);
    await this.#store.insert(this.#newMessage(sessionId, "user", content));

    this.#streams.publish(sessionId, {
      type: "phase_change",
      phase: "requesting",
    });

    try {
      this.#streams.publish(sessionId, {
        type: "phase_change",
        phase: "thinking",
      });

      const tools = this.#mcpClient ? await this.#mcpClient.listTools() : [];
      const useTools = tools.length > 0 && !!this.#completer.completeWithTools;

      if (useTools) {
        await this.#runToolLoop(sessionId, abortController, tools as McpTool[]);
      } else {
        await this.#runTextLoop(sessionId, abortController);
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      this.#streams.publish(sessionId, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  cancel(sessionId: string): void {
    this.#abortController?.abort();
    this.#abortController = null;
    this.#streams.publish(sessionId, { type: "done" });
  }

  async getMessages(
    sessionId: string,
    options: { before?: string; limit?: number } = {},
  ): Promise<ConversationPage> {
    return this.#store.listPage(sessionId, {
      ...(options.before ? { before: options.before } : {}),
      limit: options.limit ?? 50,
    });
  }

  async getMessagesForApi(sessionId: string): Promise<ConversationMessage[]> {
    return messagesSinceLastBoundary(await this.#store.listAll(sessionId));
  }

  async getTokenCount(sessionId: string): Promise<number> {
    return this.#tokenCounter(await this.getMessagesForApi(sessionId));
  }

  async clear(sessionId: string): Promise<void> {
    await this.#store.deleteAll(sessionId);
  }

  async #runTextLoop(
    sessionId: string,
    abortController: AbortController,
  ): Promise<void> {
    const llmMessages = (await this.getMessagesForApi(sessionId)).map(
      toLLMMessage,
    );
    let response = "";

    for await (const delta of this.#completer.complete(llmMessages, {
      maxTokens: this.#maxResponseTokens,
    })) {
      if (abortController.signal.aborted) break;
      response += delta;
      this.#streams.publish(sessionId, { type: "token", delta });
    }

    if (!abortController.signal.aborted) {
      await this.#store.insert(
        this.#newMessage(sessionId, "assistant", response),
      );
      this.#streams.publish(sessionId, { type: "done" });
    }
  }

  async #runToolLoop(
    sessionId: string,
    abortController: AbortController,
    tools: McpTool[],
  ): Promise<void> {
    const completeWithTools = this.#completer.completeWithTools?.bind(
      this.#completer,
    );
    if (!completeWithTools) {
      await this.#runTextLoop(sessionId, abortController);
      return;
    }

    for (let turn = 0; turn < this.#maxToolTurns; turn++) {
      if (abortController.signal.aborted) break;

      const llmMessages = (await this.getMessagesForApi(sessionId)).map(
        toLLMMessage,
      );
      const toolUses: ToolUseCall[] = [];
      let textResponse = "";

      for await (const event of completeWithTools(llmMessages, tools, {
        maxTokens: this.#maxResponseTokens,
      })) {
        if (abortController.signal.aborted) break;
        if (event.type === "token") {
          textResponse += event.delta;
          this.#streams.publish(sessionId, {
            type: "token",
            delta: event.delta,
          });
        } else if (event.type === "tool_use") {
          toolUses.push(event);
        }
      }

      if (abortController.signal.aborted) break;

      if (toolUses.length === 0) {
        // No tool calls — final text response
        await this.#store.insert(
          this.#newMessage(sessionId, "assistant", textResponse),
        );
        this.#streams.publish(sessionId, { type: "done" });
        return;
      }

      // Persist assistant message with tool_use blocks
      const assistantContent: ConversationContentBlock[] = [];
      if (textResponse) {
        assistantContent.push({ type: "text", text: textResponse });
      }
      for (const tu of toolUses) {
        assistantContent.push({
          type: "tool_use",
          id: tu.id,
          name: tu.name,
          input: tu.input,
        });
      }
      await this.#store.insert(
        this.#newMessageWithContent(sessionId, "assistant", assistantContent),
      );

      // Execute each tool
      for (const toolUse of toolUses) {
        if (abortController.signal.aborted) break;
        await this.#executeToolUse(sessionId, abortController, toolUse);
      }
    }

    if (!abortController.signal.aborted) {
      this.#streams.publish(sessionId, { type: "done" });
    }
  }

  async #executeToolUse(
    sessionId: string,
    abortController: AbortController,
    toolUse: ToolUseCall,
  ): Promise<void> {
    const requestId = this.#createId();

    // Emit informational frame — server name comes from the namespaced tool name
    const sepIdx = toolUse.name.indexOf("__");
    const server = sepIdx !== -1 ? toolUse.name.slice(0, sepIdx) : "mcp";
    const tool = sepIdx !== -1 ? toolUse.name.slice(sepIdx + 2) : toolUse.name;
    this.#streams.publish(sessionId, {
      type: "mcp_tool_call",
      server,
      tool,
      input: toolUse.input,
    });

    // Gate on user permission
    const approved =
      (await this.#permissionChecker?.requestPermission(
        sessionId,
        requestId,
        `mcp:${tool}`,
        toolUse.input,
      )) ?? true;

    let resultText: string;
    if (!approved || abortController.signal.aborted) {
      resultText = "Tool call rejected by user.";
    } else {
      try {
        resultText =
          (await this.#mcpClient?.callTool(toolUse.name, toolUse.input)) ??
          "Tool unavailable.";
      } catch (e) {
        resultText = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    const resultContent: ConversationContentBlock[] = [
      {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: resultText,
      },
    ];
    await this.#store.insert(
      this.#newMessageWithContent(sessionId, "tool_result", resultContent),
    );
  }

  #newMessage(
    sessionId: string,
    role: ConversationMessage["role"],
    content: string,
  ): ConversationMessage {
    const blocks: ConversationContentBlock[] = [
      { type: "text", text: content },
    ];
    return this.#newMessageWithContent(sessionId, role, blocks);
  }

  #newMessageWithContent(
    sessionId: string,
    role: ConversationMessage["role"],
    content: ConversationContentBlock[],
  ): ConversationMessage {
    return {
      id: this.#createId(),
      sessionId,
      role,
      content,
      hasThinking: false,
      tokenCount: this.#tokenCounter([{ content }]),
      compactionBoundary: false,
      createdAt: this.#now(),
    };
  }
}

interface ToolUseCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function toLLMMessage(message: ConversationMessage): LLMMessage {
  const allText = message.content.every((b) => b.type === "text");

  if (allText) {
    return {
      role: message.role === "tool_result" ? "user" : message.role,
      content: contentToText(message),
    };
  }

  return {
    role: message.role === "tool_result" ? "user" : message.role,
    content: message.content as LLMContentBlock[],
  };
}

export function contentToText(message: ConversationMessage): string {
  return message.content
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
}
