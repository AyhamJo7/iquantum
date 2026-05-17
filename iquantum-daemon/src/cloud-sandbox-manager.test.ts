import { RunTaskCommand } from "@aws-sdk/client-ecs";
import { describe, expect, it } from "vitest";
import { CloudSandboxManager } from "./cloud-sandbox-manager";

describe("CloudSandboxManager", () => {
  it("starts Fargate tasks with the required awsvpc network configuration", async () => {
    const commands: unknown[] = [];
    const manager = new CloudSandboxManager({
      region: "eu-central-1",
      cluster: "cluster",
      efsFileSystemId: "fs-1",
      taskDefinition: "iquantum-sandbox",
      subnetIds: ["subnet-a", "subnet-b"],
      securityGroupIds: ["sg-a"],
      assignPublicIp: false,
      ecs: {
        async send(command: unknown) {
          commands.push(command);
          return { tasks: [{ taskArn: "task-1" }] };
        },
      } as never,
    });

    await manager.start("session-1");

    expect(commands[0]).toBeInstanceOf(RunTaskCommand);
    expect((commands[0] as RunTaskCommand).input).toMatchObject({
      enableExecuteCommand: true,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ["subnet-a", "subnet-b"],
          securityGroups: ["sg-a"],
          assignPublicIp: "DISABLED",
        },
      },
    });
  });
});
