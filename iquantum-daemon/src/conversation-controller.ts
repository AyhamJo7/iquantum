import { countTokens } from "@iquantum/context-window";
import type { SandboxFileTools } from "@iquantum/file-tools";
import { type BuiltinTool, createFileToolBuiltins } from "@iquantum/llm";
import type { SandboxManager } from "@iquantum/sandbox";
import type {
  CompletionEvent,
  IMcpClient,
  LLMContentBlock,
  LLMMessage,
  McpTool,
  Memory,
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

export interface ConversationMemoryManager {
  store: {
    upsertByName(memory: Memory): Promise<Memory>;
  };
  buildBlock(
    userId: string,
    orgId: string | null,
  ): Promise<{ text: string; tokenCount: number }>;
  materialize(userId: string, orgId: string | null): Promise<void>;
}

export interface ConversationControllerOptions {
  store: ConversationStore;
  completer: ConversationCompleter;
  streams: ConversationStreams;
  compactor?: ConversationCompactor;
  mcpClient?: IMcpClient;
  fileTools?: {
    tools: SandboxFileTools;
    sandbox: Pick<SandboxManager, "exec">;
  };
  permissionChecker?: PermissionChecker;
  memoryManager?: ConversationMemoryManager;
  memoryUserId?: string;
  memoryOrgId?: string | null;
  autoMemory?: boolean;
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
  readonly #fileTools:
    | {
        tools: SandboxFileTools;
        sandbox: Pick<SandboxManager, "exec">;
      }
    | undefined;
  readonly #permissionChecker: PermissionChecker | undefined;
  readonly #memoryManager: ConversationMemoryManager | undefined;
  readonly #memoryUserId: string;
  readonly #memoryOrgId: string | null;
  readonly #autoMemory: boolean;
  readonly #maxResponseTokens: number;
  readonly #maxToolTurns: number;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #tokenCounter: typeof countTokens;
  readonly #memoryTokenCounts = new Map<string, number>();
  #abortController: AbortController | null = null;
  #currentMemoryBlock: { text: string; tokenCount: number } | null | undefined;

  constructor(options: ConversationControllerOptions) {
    this.#store = options.store;
    this.#completer = options.completer;
    this.#streams = options.streams;
    this.#compactor = options.compactor;
    this.#mcpClient = options.mcpClient;
    this.#fileTools = options.fileTools;
    this.#permissionChecker = options.permissionChecker;
    this.#memoryManager = options.memoryManager;
    this.#memoryUserId = options.memoryUserId ?? "local";
    this.#memoryOrgId = options.memoryOrgId ?? null;
    this.#autoMemory = options.autoMemory ?? false;
    this.#maxResponseTokens = options.maxResponseTokens ?? 2000;
    this.#maxToolTurns = options.maxToolTurns ?? MAX_TOOL_TURNS_DEFAULT;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#tokenCounter = options.tokenCounter ?? countTokens;
  }

  async addMessage(
    sessionId: string,
    content: string,
    userId?: string,
    orgId?: string,
  ): Promise<void> {
    this.#abortController?.abort();
    const abortController = new AbortController();
    this.#abortController = abortController;
    this.#currentMemoryBlock = undefined;

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

      const mcpTools = this.#mcpClient ? await this.#mcpClient.listTools() : [];
      const builtinTools = this.#fileTools
        ? createFileToolBuiltins(
            this.#fileTools.tools,
            this.#fileTools.sandbox,
            sessionId,
          )
        : [];
      const tools = [...mcpTools, ...builtinTools];
      const useTools = tools.length > 0 && !!this.#completer.completeWithTools;

      if (useTools) {
        await this.#runToolLoop(
          sessionId,
          abortController,
          tools as McpTool[],
          builtinTools,
          userId,
          orgId,
        );
      } else {
        await this.#runTextLoop(sessionId, abortController, userId, orgId);
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
    orgId?: string,
  ): Promise<ConversationPage> {
    return this.#store.listPage(
      sessionId,
      {
        ...(options.before ? { before: options.before } : {}),
        limit: options.limit ?? 50,
      },
      orgId,
    );
  }

  async getMessagesForApi(
    sessionId: string,
    orgId?: string,
  ): Promise<ConversationMessage[]> {
    return messagesSinceLastBoundary(
      await this.#store.listAll(sessionId, orgId),
    );
  }

  async getTokenCount(sessionId: string, orgId?: string): Promise<number> {
    return (
      this.#tokenCounter(await this.getMessagesForApi(sessionId, orgId)) +
      (this.#memoryTokenCounts.get(sessionId) ?? 0)
    );
  }

  getMemoryTokenCount(sessionId: string): number {
    return this.#memoryTokenCounts.get(sessionId) ?? 0;
  }

  async clear(sessionId: string, orgId?: string): Promise<void> {
    await this.#store.deleteAll(sessionId, orgId);
  }

  async #runTextLoop(
    sessionId: string,
    abortController: AbortController,
    userId?: string,
    orgId?: string,
  ): Promise<void> {
    const llmMessages = await this.#llmMessages(sessionId, userId, orgId);
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
      await this.#maybeAutoRemember(sessionId, userId, orgId).catch(
        () => undefined,
      );
      this.#streams.publish(sessionId, { type: "done" });
    }
  }

  async #runToolLoop(
    sessionId: string,
    abortController: AbortController,
    tools: McpTool[],
    builtinTools: BuiltinTool[],
    userId?: string,
    orgId?: string,
  ): Promise<void> {
    const completeWithTools = this.#completer.completeWithTools?.bind(
      this.#completer,
    );
    if (!completeWithTools) {
      await this.#runTextLoop(sessionId, abortController, orgId);
      return;
    }

    for (let turn = 0; turn < this.#maxToolTurns; turn++) {
      if (abortController.signal.aborted) break;

      const llmMessages = await this.#llmMessages(sessionId, userId, orgId);
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
        await this.#maybeAutoRemember(sessionId, userId, orgId).catch(
          () => undefined,
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
        await this.#executeToolUse(
          sessionId,
          abortController,
          toolUse,
          builtinTools,
        );
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
    builtinTools: BuiltinTool[],
  ): Promise<void> {
    const requestId = this.#createId();
    const builtinTool = builtinTools.find((tool) => tool.name === toolUse.name);

    // Emit informational frame — server name comes from the namespaced tool name
    const sepIdx = toolUse.name.indexOf("__");
    const server =
      builtinTool !== undefined
        ? "builtin"
        : sepIdx !== -1
          ? toolUse.name.slice(0, sepIdx)
          : "mcp";
    const tool = sepIdx !== -1 ? toolUse.name.slice(sepIdx + 2) : toolUse.name;
    this.#streams.publish(sessionId, {
      type: "mcp_tool_call",
      server,
      tool,
      input: toolUse.input,
    });

    // Gate on user permission
    const approved =
      builtinTool !== undefined
        ? true
        : ((await this.#permissionChecker?.requestPermission(
            sessionId,
            requestId,
            `mcp:${tool}`,
            toolUse.input,
          )) ?? true);

    let resultText: string;
    if (!approved || abortController.signal.aborted) {
      resultText = "Tool call rejected by user.";
    } else {
      try {
        resultText = builtinTool
          ? await builtinTool.execute(toolUse.input)
          : ((await this.#mcpClient?.callTool(toolUse.name, toolUse.input)) ??
            "Tool unavailable.");
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

  async #llmMessages(
    sessionId: string,
    userId?: string,
    orgId?: string,
  ): Promise<LLMMessage[]> {
    const messages = (await this.getMessagesForApi(sessionId, orgId)).map(
      toLLMMessage,
    );

    if (this.#currentMemoryBlock === undefined) {
      const block = await this.#memoryManager?.buildBlock(
        userId ?? this.#memoryUserId,
        orgId ?? this.#memoryOrgId,
      );
      this.#currentMemoryBlock = block ?? null;
    }

    const memory = this.#currentMemoryBlock;

    if (!memory?.text) {
      this.#memoryTokenCounts.set(sessionId, 0);
      return messages;
    }

    this.#memoryTokenCounts.set(sessionId, memory.tokenCount);
    return [
      {
        role: "system",
        content: `## Your Memory\n\n${memory.text}\n\n---\n\n`,
      },
      ...messages,
    ];
  }

  async #maybeAutoRemember(
    sessionId: string,
    userId?: string,
    orgId?: string,
  ): Promise<void> {
    if (!this.#autoMemory || !this.#memoryManager) return;

    const messages = await this.getMessagesForApi(sessionId, orgId);
    const userTurns = messages.filter(
      (message) => message.role === "user",
    ).length;
    if (userTurns === 0 || userTurns % 20 !== 0) return;

    let summary = "";
    for await (const delta of this.#completer.complete(
      [
        {
          role: "system",
          content:
            "Summarize stable user or project preferences worth remembering. Return only the memory text. Return nothing if there is no durable memory.",
        },
        {
          role: "user",
          content: messages.map(contentToText).join("\n\n"),
        },
      ],
      { maxTokens: 300 },
    )) {
      summary += delta;
    }

    const body = summary.trim();
    if (!body) return;

    const identity = {
      userId: userId ?? this.#memoryUserId,
      orgId: orgId ?? this.#memoryOrgId,
    };
    const now = this.#now();
    await this.#memoryManager.store.upsertByName({
      id: this.#createId(),
      userId: identity.userId,
      orgId: identity.orgId,
      type: "project",
      name: `auto-${sessionId.slice(0, 8)}-${Math.floor(userTurns / 20)}`,
      description: "Auto-generated conversation memory",
      body,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    });
    await this.#memoryManager.materialize(identity.userId, identity.orgId);
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
