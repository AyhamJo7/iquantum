import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonChildEnv, daemonStatus, resolveDaemonEntry } from "./daemon";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("resolveDaemonEntry", () => {
  it("prefers the monorepo source entry during development", () => {
    expect(
      resolveDaemonEntry("/repo/iquantum-cli/src/commands", () => true),
    ).toBe("/repo/iquantum-daemon/src/index.ts");
  });

  it("uses the co-located bundled daemon after install", () => {
    expect(resolveDaemonEntry("/pkg/dist", () => false)).toBe(
      "/pkg/dist/daemon.js",
    );
  });
});

describe("daemonChildEnv", () => {
  it("merges config file values below explicit environment values", async () => {
    const dir = join(tmpdir(), `iq-daemon-env-${crypto.randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({
        ANTHROPIC_API_KEY: "from-file",
        MAX_RETRIES: "3",
      }),
    );

    expect(
      daemonChildEnv(dir, {
        ANTHROPIC_API_KEY: "from-env",
      }),
    ).toMatchObject({
      ANTHROPIC_API_KEY: "from-env",
      MAX_RETRIES: "3",
    });
  });
});

describe("daemonStatus", () => {
  it("reports running when health check succeeds", async () => {
    const output: string[] = [];
    const writer = { writeln: (line: string) => output.push(line) };

    await daemonStatus(
      {
        client: {
          async health() {
            return { ok: true };
          },
        },
      },
      writer,
    );

    expect(output).toEqual(["daemon is running"]);
  });

  it("reports not running when health check throws", async () => {
    const output: string[] = [];
    const writer = { writeln: (line: string) => output.push(line) };

    await daemonStatus(
      {
        client: {
          async health() {
            throw new Error("ENOENT");
          },
        },
      },
      writer,
    );

    expect(output).toEqual(["daemon is not running"]);
  });
});
