import { lookup } from "node:dns/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebFetchTool } from "./web-fetch";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const lookupMock = vi.mocked(lookup);

describe("WebFetchTool", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    mockLookup("93.184.216.34");
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns an error string for SSRF attempts without calling fetch", async () => {
    mockLookup("192.168.1.1");
    const fetchMock = vi.mocked(fetch);

    const result = await new WebFetchTool().execute({
      url: "http://192.168.1.1",
    });

    expect(result).toContain("Error:");
    expect(result).toContain("Blocked URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("converts HTML responses to markdown by default", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("<h1>Hello</h1><p>Read <strong>this</strong>.</p>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const result = await new WebFetchTool().execute({
      url: "https://example.com/page",
    });

    expect(result).toContain("Content from https://example.com/page");
    expect(result).toContain("Hello");
    expect(result).toContain("**this**");
  });

  it("handles HTML content type case-insensitively", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("<h1>Hello</h1>", {
        headers: { "content-type": "Text/HTML; Charset=UTF-8" },
      }),
    );

    const result = await new WebFetchTool().execute({
      url: "https://example.com/page",
    });

    expect(result).toContain("Hello");
    expect(result).not.toContain("<h1>");
  });

  it("passes through plain text responses", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("plain content", {
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await new WebFetchTool().execute({
      url: "https://example.com/plain.txt",
    });

    expect(result).toBe(
      "Content from https://example.com/plain.txt:\n\nplain content",
    );
  });

  it("strips HTML when text format is requested", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("<h1>Hello</h1><script>bad()</script><p>World</p>", {
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await new WebFetchTool().execute({
      url: "https://example.com/page",
      format: "text",
    });

    expect(result).toBe(
      "Content from https://example.com/page:\n\nHello World",
    );
  });

  it("preserves HTML when raw format is requested", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("<h1>Hello</h1>", {
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await new WebFetchTool().execute({
      url: "https://example.com/page",
      format: "raw",
    });

    expect(result).toBe(
      "Content from https://example.com/page:\n\n<h1>Hello</h1>",
    );
  });

  it("blocks redirects to private addresses before following them", async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "192.168.1.1", family: 4 }] as never);
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://192.168.1.1/admin" },
      }),
    );

    const result = await new WebFetchTool().execute({
      url: "https://example.com/redirect",
    });

    expect(result).toContain("Blocked URL http://192.168.1.1/admin");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("stops after five redirects", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, _init) => {
      const next = vi.mocked(fetch).mock.calls.length + 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://example.com/redirect-${next}` },
      });
    });

    const result = await new WebFetchTool().execute({
      url: "https://example.com/redirect-0",
    });

    expect(result).toContain(
      "Too many redirects fetching https://example.com/redirect-0",
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(6);
  });

  it("allows five redirects before a final response", async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      const call = vi.mocked(fetch).mock.calls.length;
      if (call <= 5) {
        return new Response(null, {
          status: 302,
          headers: { location: `https://example.com/redirect-${call}` },
        });
      }

      return new Response("done", {
        headers: { "content-type": "text/plain" },
      });
    });

    const result = await new WebFetchTool().execute({
      url: "https://example.com/redirect-0",
    });

    expect(result).toBe("Content from https://example.com/redirect-0:\n\ndone");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(6);
  });

  it("truncates oversized responses", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("a".repeat(2_097_153), {
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await new WebFetchTool().execute({
      url: "https://example.com/large.txt",
    });

    expect(result).toContain("[Response truncated after 2MB]");
    expect(result.length).toBeLessThan(2_097_300);
  });

  it("uses an abort signal and returns an error string when fetch aborts", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("operation timed out"));

    const result = await new WebFetchTool().execute({
      url: "https://example.com/slow",
    });

    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(result).toContain("operation timed out");
  });
});

function mockLookup(address: string): void {
  lookupMock.mockResolvedValue([{ address, family: 4 }] as never);
}
