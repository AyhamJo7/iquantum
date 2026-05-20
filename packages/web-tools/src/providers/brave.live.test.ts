import { describe, expect, it } from "vitest";
import { BraveSearchClient } from "./brave";

const braveApiKey = process.env.BRAVE_API_KEY;

describe.skipIf(!braveApiKey)("BraveSearchClient live acceptance", () => {
  it("searches the web for the latest Bun version", async () => {
    const results = await new BraveSearchClient(braveApiKey as string).search(
      "what is the latest version of bun?",
      5,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((result) =>
        [result.title, result.url, result.snippet]
          .join(" ")
          .toLowerCase()
          .includes("bun"),
      ),
    ).toBe(true);
  });
});
