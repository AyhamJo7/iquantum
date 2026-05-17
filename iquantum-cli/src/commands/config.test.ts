import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configGet, configList, configSet } from "./config";

function makeWriter() {
  const lines: string[] = [];
  return {
    writer: {
      write: (s: string) => lines.push(s),
      writeln: (s: string) => lines.push(s),
    },
    lines,
  };
}

describe("config commands", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `iq-cfg-test-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("configList", () => {
    it("shows all keys from config file", async () => {
      await configSet(
        "ANTHROPIC_API_KEY",
        "sk-ant-testkey",
        makeWriter().writer,
        tmpDir,
      );
      await configSet("MAX_RETRIES", "5", makeWriter().writer, tmpDir);
      const { writer, lines } = makeWriter();
      configList(writer, tmpDir);
      expect(lines.join("\n")).toContain("MAX_RETRIES=5");
    });

    it("redacts the API key", async () => {
      await configSet(
        "ANTHROPIC_API_KEY",
        "sk-ant-supersecret1234",
        makeWriter().writer,
        tmpDir,
      );
      const { writer, lines } = makeWriter();
      configList(writer, tmpDir);
      const output = lines.join("\n");
      expect(output).toContain("sk-...");
      expect(output).not.toContain("supersecret");
    });

    it("redacts the OpenAI-compatible provider API key", async () => {
      await configSet(
        "IQUANTUM_API_KEY",
        "sk-openai-supersecret1234",
        makeWriter().writer,
        tmpDir,
      );
      const { writer, lines } = makeWriter();
      configList(writer, tmpDir);
      const output = lines.join("\n");
      expect(output).toContain("sk-...");
      expect(output).not.toContain("supersecret");
    });

    it("reports no config file when absent", () => {
      const { writer, lines } = makeWriter();
      configList(writer, tmpDir);
      expect(lines.join("\n")).toContain("No config file");
    });
  });

  describe("configSet", () => {
    it("writes a known key", async () => {
      const { writer, lines } = makeWriter();
      await configSet("MAX_RETRIES", "7", writer, tmpDir);
      expect(lines.join("\n")).toContain("set MAX_RETRIES");
    });

    it("rejects an unknown key", async () => {
      const { writer, lines } = makeWriter();
      await configSet("UNKNOWN_KEY", "value", writer, tmpDir);
      expect(lines.join("\n")).toContain("Unknown config key");
    });

    it("set then get round-trip", async () => {
      await configSet("MAX_RETRIES", "9", makeWriter().writer, tmpDir);
      const { writer, lines } = makeWriter();
      configGet("MAX_RETRIES", writer, tmpDir);
      expect(lines.join("\n")).toBe("9");
    });
  });

  describe("configGet", () => {
    it("prints (not set) when key is absent", () => {
      const { writer, lines } = makeWriter();
      configGet("MAX_RETRIES", writer, tmpDir);
      expect(lines.join("\n")).toBe("(not set)");
    });

    it("rejects an unknown key", () => {
      const { writer, lines } = makeWriter();
      configGet("SOME_UNKNOWN", writer, tmpDir);
      expect(lines.join("\n")).toContain("Unknown config key");
    });

    it("redacts API key in get output", async () => {
      await configSet(
        "ANTHROPIC_API_KEY",
        "sk-ant-secret5678",
        makeWriter().writer,
        tmpDir,
      );
      const { writer, lines } = makeWriter();
      configGet("ANTHROPIC_API_KEY", writer, tmpDir);
      expect(lines.join("\n")).toContain("sk-...");
      expect(lines.join("\n")).not.toContain("secret");
    });
  });
});
