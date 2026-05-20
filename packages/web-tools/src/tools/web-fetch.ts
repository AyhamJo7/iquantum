import TurndownService from "turndown";
import { z } from "zod";
import type { WebTool } from "../index";
import { assertNotSsrf } from "../ssrf-guard";

const MAX_BYTES = 2_097_152;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const TRUNCATED_SUFFIX = "\n\n[Response truncated after 2MB]";

const inputSchema = {
  type: "object",
  properties: {
    url: { type: "string" },
    format: { type: "string", enum: ["text", "markdown", "raw"] },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

const inputParser = z.object({
  url: z.string().url(),
  format: z.enum(["text", "markdown", "raw"]).optional().default("markdown"),
});

export class WebFetchTool implements WebTool {
  readonly name = "web_fetch";
  readonly description =
    "Fetch a public HTTP(S) URL and return text, markdown, or raw content.";
  readonly inputSchema = inputSchema;

  async execute(input: unknown): Promise<string> {
    try {
      const parsed = inputParser.parse(input);
      await assertNotSsrf(parsed.url);
      const response = await fetchWithRedirects(parsed.url);
      const contentType = (response.headers.get("content-type") ?? "")
        .toLowerCase()
        .trim();
      const body = await readBody(response);
      let result = body.text;

      if (contentType.includes("text/html") && parsed.format !== "raw") {
        result =
          parsed.format === "text"
            ? stripHtml(result)
            : new TurndownService().turndown(result);
      }

      if (body.truncated) {
        result += TRUNCATED_SUFFIX;
      }

      return `Content from ${response.url || parsed.url}:\n\n${result}`;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

async function fetchWithRedirects(url: string): Promise<Response> {
  let current = url;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!isRedirect(response.status)) {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${current}`);
      }

      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Redirect from ${current} did not include a location`);
    }

    current = new URL(location, current).toString();
    await assertNotSsrf(current);
  }

  throw new Error(`Too many redirects fetching ${url}`);
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function readBody(
  response: Response,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return decode(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    const remaining = MAX_BYTES - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      total += remaining;
      truncated = true;
      break;
    }

    chunks.push(value);
    total += value.byteLength;
  }

  return {
    text: Buffer.concat(chunks, total).toString("utf8"),
    truncated,
  };
}

function decode(buffer: Buffer): { text: string; truncated: boolean } {
  if (buffer.byteLength <= MAX_BYTES) {
    return { text: buffer.toString("utf8"), truncated: false };
  }

  return {
    text: buffer.subarray(0, MAX_BYTES).toString("utf8"),
    truncated: true,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
