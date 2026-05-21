import type { SnapshotStore } from "@iquantum/snapshots";
import { describe, expect, it } from "vitest";
import { SnapshotController } from "./snapshot-controller";

describe("SnapshotController", () => {
  it("saves sandbox files as decoded snapshot content", async () => {
    const saved: Array<{
      sessionId: string;
      turnIndex: number;
      files: Map<string, string>;
    }> = [];
    const controller = new SnapshotController({
      store: {
        async save(
          sessionId: string,
          turnIndex: number,
          files: Map<string, string>,
        ) {
          saved.push({ sessionId, turnIndex, files });
        },
      } as unknown as SnapshotStore,
      sandbox: {
        async exec(_sessionId, command) {
          expect(command).toContain("base64");
          return {
            stdout: Buffer.from("hello").toString("base64"),
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    await controller.saveFilesFromSandbox("session-1", 4, ["src/a.ts"]);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.sessionId).toBe("session-1");
    expect(saved[0]?.turnIndex).toBe(4);
    expect(saved[0]?.files.get("src/a.ts")).toBe("hello");
  });

  it("restores snapshot files back into the sandbox", async () => {
    const commands: string[] = [];
    const controller = new SnapshotController({
      store: {
        async restore() {
          return new Map([["src/a.ts", "hello"]]);
        },
      } as unknown as SnapshotStore,
      sandbox: {
        async exec(_sessionId, command) {
          commands.push(command);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    });

    await controller.restoreToSandbox("session-1", 4);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("mkdir -p");
    expect(commands[0]).toContain("base64 -d");
  });
});
