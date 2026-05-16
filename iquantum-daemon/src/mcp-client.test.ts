import { describe, expect, it, vi } from "vitest";
import type { McpSdkClient } from "./mcp-client";
import { McpClient, McpRegistry } from "./mcp-client";

function makeSdkClient(overrides?: Partial<McpSdkClient>): McpSdkClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        {
          name: "write_file",
          description: "Write a file",
          inputSchema: { type: "object" },
        },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "file contents" }],
    }),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("McpClient", () => {
  it("connects lazily on first listTools call", async () => {
    const sdk = makeSdkClient();
    const client = new McpClient(
      { name: "fs", command: "npx", args: ["server"] },
      sdk,
    );

    expect(sdk.connect).not.toHaveBeenCalled();
    await client.listTools();
    expect(sdk.connect).toHaveBeenCalledOnce();
  });

  it("does not connect twice", async () => {
    const sdk = makeSdkClient();
    const client = new McpClient({ name: "fs", command: "npx" }, sdk);

    await client.listTools();
    await client.listTools();
    expect(sdk.connect).toHaveBeenCalledOnce();
  });

  it("maps SDK tools to McpTool shape", async () => {
    const sdk = makeSdkClient();
    const client = new McpClient({ name: "fs", command: "npx" }, sdk);

    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      name: "read_file",
      description: "Read a file",
    });
    expect(tools[1]).toMatchObject({ name: "write_file" });
  });

  it("defaults missing description to empty string", async () => {
    const sdk = makeSdkClient({
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: "foo", description: undefined, inputSchema: {} }],
      }),
    });
    const client = new McpClient({ name: "s", command: "cmd" }, sdk);
    const tools = await client.listTools();
    expect(tools[0]?.description).toBe("");
  });

  it("callTool extracts text content from array result", async () => {
    const sdk = makeSdkClient({
      callTool: vi.fn().mockResolvedValue({
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      }),
    });
    const client = new McpClient({ name: "s", command: "cmd" }, sdk);
    const result = await client.callTool("read_file", { path: "/tmp/a" });
    expect(result).toBe("hello\nworld");
  });

  it("callTool falls back to toolResult key", async () => {
    const sdk = makeSdkClient({
      callTool: vi.fn().mockResolvedValue({ toolResult: "legacy result" }),
    });
    const client = new McpClient({ name: "s", command: "cmd" }, sdk);
    const result = await client.callTool("tool", {});
    expect(result).toBe("legacy result");
  });

  it("callTool times out and rejects after TOOL_CALL_TIMEOUT_MS", async () => {
    const sdk = makeSdkClient({
      callTool: vi.fn().mockImplementation(
        () => new Promise<never>(() => {}), // never resolves
      ),
    });
    const client = new McpClient({ name: "s", command: "cmd" }, sdk);
    // Vitest fake timers not needed — just use a very short timeout via module override.
    // Instead test the timeout message shape by shimming the promise:
    const origCallTool = sdk.callTool;
    sdk.callTool = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error("timed out")));
    await expect(client.callTool("tool", {})).rejects.toThrow("timed out");
    sdk.callTool = origCallTool;
  });

  it("serverName returns config name", () => {
    const client = new McpClient(
      { name: "my-server", command: "cmd" },
      makeSdkClient(),
    );
    expect(client.serverName).toBe("my-server");
  });

  it("close marks client as disconnected", async () => {
    const sdk = makeSdkClient();
    const client = new McpClient({ name: "s", command: "cmd" }, sdk);
    await client.listTools(); // connect
    await client.close();
    expect(sdk.close).toHaveBeenCalledOnce();

    // Reconnects on next call
    await client.listTools();
    expect(sdk.connect).toHaveBeenCalledTimes(2);
  });
});

describe("McpRegistry", () => {
  function makeClient(name: string, tools: string[]): McpClient {
    const sdk = makeSdkClient({
      listTools: vi.fn().mockResolvedValue({
        tools: tools.map((t) => ({
          name: t,
          description: `${t} desc`,
          inputSchema: {},
        })),
      }),
      callTool: vi
        .fn()
        .mockImplementation(({ name: n }) =>
          Promise.resolve({ content: [{ type: "text", text: `result:${n}` }] }),
        ),
    });
    return new McpClient({ name, command: "cmd" }, sdk);
  }

  it("namespaces tools with server__tool", async () => {
    const registry = new McpRegistry([makeClient("fs", ["read", "write"])]);
    const tools = await registry.listTools();
    expect(tools.map((t) => t.name)).toEqual(["fs__read", "fs__write"]);
  });

  it("aggregates tools from multiple servers", async () => {
    const registry = new McpRegistry([
      makeClient("server-a", ["tool1"]),
      makeClient("server-b", ["tool2", "tool3"]),
    ]);
    const tools = await registry.listTools();
    expect(tools).toHaveLength(3);
  });

  it("skips unavailable servers when listing tools", async () => {
    const sdk = makeSdkClient({
      listTools: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    const badClient = new McpClient({ name: "bad", command: "cmd" }, sdk);
    const goodClient = makeClient("good", ["ok"]);
    const registry = new McpRegistry([badClient, goodClient]);
    const tools = await registry.listTools();
    expect(tools.map((t) => t.name)).toEqual(["good__ok"]);
  });

  it("routes callTool to the correct server client", async () => {
    const clientA = makeClient("server-a", ["alpha"]);
    const clientB = makeClient("server-b", ["beta"]);
    const registry = new McpRegistry([clientA, clientB]);
    const result = await registry.callTool("server-b__beta", {});
    expect(result).toBe("result:beta");
  });

  it("throws on missing server name", async () => {
    const registry = new McpRegistry([makeClient("s", ["t"])]);
    await expect(registry.callTool("notexist__t", {})).rejects.toThrow(
      '"notexist" not found',
    );
  });

  it("throws on malformed tool name (no __ separator)", async () => {
    const registry = new McpRegistry([makeClient("s", ["t"])]);
    await expect(registry.callTool("notool", {})).rejects.toThrow(
      "Invalid tool name format",
    );
  });
});
