import { describe, expect, it } from "vitest";
import { daemonStatus } from "./daemon";

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
