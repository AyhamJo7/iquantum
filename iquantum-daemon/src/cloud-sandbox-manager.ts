import { createHash, randomBytes } from "node:crypto";
import {
  DescribeTasksCommand,
  ECSClient,
  ExecuteCommandCommand,
  RunTaskCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import type { ExecChunk, ExecResult, SandboxRuntime } from "@iquantum/sandbox";

export interface CloudSandboxManagerOptions {
  region: string;
  cluster: string;
  efsFileSystemId: string;
  taskDefinition: string;
  subnetIds: string[];
  securityGroupIds: string[];
  assignPublicIp?: boolean;
  ecs?: ECSClient;
  execTimeoutMs?: number;
}

// Sentinel appended to every command so we can reliably extract the exit code
// from PTY output without relying on the SSM close event.
const EXIT_SENTINEL = "__IQEXIT_CODE__";

// SSM Client Message binary protocol (aws-ssm-agent session/contracts).
// Wire format:
//   [0:4]    HeaderLength  uint32 = 116 (length of remaining header fields)
//   [4:36]   MessageType   string (32 bytes, NUL-padded)
//   [36:40]  SchemaVersion uint32 = 1
//   [40:48]  CreatedDate   uint64 (ms since epoch)
//   [48:56]  SequenceNumber int64
//   [56:64]  Flags         uint64
//   [64:80]  MessageId     bytes (16, UUID)
//   [80:112] PayloadDigest bytes (32, SHA-256 of payload)
//   [112:116] PayloadType  uint32
//   [116:120] PayloadLength uint32
//   [120:]   Payload
const SSM_TOTAL_HEADER = 120;
const SSM_HEADER_BODY = 116;

interface SsmMessage {
  type: string;
  seqNum: bigint;
  messageId: Buffer;
  payload: Buffer;
}

function decodeSsmMessage(data: Buffer): SsmMessage | null {
  if (data.length < SSM_TOTAL_HEADER) return null;
  const headerLength = data.readUInt32BE(0);
  if (headerLength !== SSM_HEADER_BODY) return null;

  const type = data.subarray(4, 36).toString("utf8").replace(/\0+$/, "").trim();
  const seqNum = data.readBigInt64BE(48);
  const messageId = Buffer.from(data.subarray(64, 80));
  const payloadLength = data.readUInt32BE(116);
  if (data.length < SSM_TOTAL_HEADER + payloadLength) return null;

  return {
    type,
    seqNum,
    messageId,
    payload: Buffer.from(
      data.subarray(SSM_TOTAL_HEADER, SSM_TOTAL_HEADER + payloadLength),
    ),
  };
}

function encodeSsmAck(msg: SsmMessage, clientSeqNum: bigint): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      AcknowledgedMessageType: msg.type,
      AcknowledgedMessageId: formatUuid(msg.messageId),
      AcknowledgedMessageSequenceNumber: Number(msg.seqNum),
      IsBufferFull: false,
    }),
  );

  const buf = Buffer.alloc(SSM_TOTAL_HEADER + payload.length);
  buf.writeUInt32BE(SSM_HEADER_BODY, 0);
  buf.write("acknowledge", 4, 32, "utf8");
  buf.writeUInt32BE(1, 36);
  buf.writeBigUInt64BE(BigInt(Date.now()), 40);
  buf.writeBigInt64BE(clientSeqNum, 48);
  buf.writeBigUInt64BE(0n, 56);
  randomBytes(16).copy(buf, 64);
  createHash("sha256").update(payload).digest().copy(buf, 80);
  buf.writeUInt32BE(0, 112);
  buf.writeUInt32BE(payload.length, 116);
  payload.copy(buf, SSM_TOTAL_HEADER);
  return buf;
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Strips ANSI escape sequences that the PTY injects into terminal output.
function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI strip
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

async function readSsmSession(
  streamUrl: string,
  tokenValue: string,
  timeoutMs: number,
): Promise<ExecResult> {
  const chunks: ExecChunk[] = [];
  let exitCode = 0;
  let clientSeq = 0n;
  let outputBuffer = "";

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(streamUrl);
    (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`SSM exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.onopen = () => {
      // SSM authentication: send token as the first TEXT frame.
      ws.send(JSON.stringify({ TokenValue: tokenValue }));
    };

    ws.onmessage = (event: MessageEvent) => {
      const raw = event.data as ArrayBuffer | string;
      // TEXT frames are control / error messages — ignore.
      if (typeof raw === "string") return;

      const msg = decodeSsmMessage(Buffer.from(raw));
      if (!msg) return;

      if (msg.type === "output_stream_data") {
        ws.send(encodeSsmAck(msg, clientSeq++));
        outputBuffer += stripAnsi(msg.payload.toString("utf8"));

        const sentinelIdx = outputBuffer.indexOf(EXIT_SENTINEL);
        if (sentinelIdx !== -1) {
          const before = outputBuffer.slice(0, sentinelIdx);
          const after = outputBuffer.slice(sentinelIdx + EXIT_SENTINEL.length);
          const codeMatch = after.match(/^:(\d+)/);
          exitCode = codeMatch ? parseInt(codeMatch[1] ?? "0", 10) : 0;
          if (before) chunks.push({ stream: "stdout", data: before });
          clearTimeout(timer);
          ws.close();
        }
      } else if (msg.type === "channel_closed") {
        // Flush remaining buffer if sentinel was never seen.
        if (outputBuffer) chunks.push({ stream: "stdout", data: outputBuffer });
        clearTimeout(timer);
        ws.close();
      }
    };

    ws.onclose = () => resolve();
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("SSM WebSocket connection failed"));
    };
  });

  return {
    output: (async function* () {
      yield* chunks;
    })(),
    exitCode: Promise.resolve(exitCode),
  };
}

export class CloudSandboxManager implements SandboxRuntime {
  readonly #ecs: ECSClient;
  readonly #tasks = new Map<string, string>();
  readonly #execTimeoutMs: number;

  constructor(private readonly config: CloudSandboxManagerOptions) {
    this.#ecs = config.ecs ?? new ECSClient({ region: config.region });
    this.#execTimeoutMs = config.execTimeoutMs ?? 120_000;
  }

  async start(
    sessionId: string,
  ): Promise<{ containerId: string; volumeId: string }> {
    const result = await this.#ecs.send(
      new RunTaskCommand({
        cluster: this.config.cluster,
        taskDefinition: this.config.taskDefinition,
        launchType: "FARGATE",
        enableExecuteCommand: true,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.config.subnetIds,
            securityGroups: this.config.securityGroupIds,
            assignPublicIp: this.config.assignPublicIp ? "ENABLED" : "DISABLED",
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: "iquantum-sandbox",
              environment: [{ name: "SESSION_ID", value: sessionId }],
            },
          ],
        },
      }),
    );
    const taskArn = result.tasks?.[0]?.taskArn;
    if (!taskArn) throw new Error("ECS RunTask returned no task ARN");
    this.#tasks.set(sessionId, taskArn);
    return {
      containerId: taskArn,
      volumeId: `${this.config.efsFileSystemId}:${sessionId}`,
    };
  }

  async exec(sessionId: string, command: string): Promise<ExecResult> {
    const taskArn = this.#tasks.get(sessionId);
    if (!taskArn)
      throw new Error(`No running ECS task for session ${sessionId}`);

    // Wrap so the exit code is emitted on stdout as a parseable sentinel.
    const escaped = command.replace(/'/g, "'\\''");
    const wrapped = `/bin/sh -c '${escaped}; echo ${EXIT_SENTINEL}:$?'`;

    const response = await this.#ecs.send(
      new ExecuteCommandCommand({
        cluster: this.config.cluster,
        task: taskArn,
        container: "iquantum-sandbox",
        command: wrapped,
        interactive: true,
      }),
    );

    const streamUrl = response.session?.streamUrl;
    const tokenValue = response.session?.tokenValue;
    if (typeof streamUrl !== "string" || typeof tokenValue !== "string") {
      throw new Error("ECS ExecuteCommand returned no SSM session credentials");
    }

    return readSsmSession(streamUrl, tokenValue, this.#execTimeoutMs);
  }

  async stop(sessionId: string): Promise<void> {
    const task = this.#tasks.get(sessionId);
    if (!task) return;
    await this.#ecs.send(
      new StopTaskCommand({
        cluster: this.config.cluster,
        task,
        reason: "session stopped",
      }),
    );
    this.#tasks.delete(sessionId);
  }

  async isRunning(sessionId: string): Promise<boolean> {
    const task = this.#tasks.get(sessionId);
    if (!task) return false;
    const result = await this.#ecs.send(
      new DescribeTasksCommand({ cluster: this.config.cluster, tasks: [task] }),
    );
    return result.tasks?.[0]?.lastStatus === "RUNNING";
  }

  volumePath(sessionId: string): string {
    return `/mnt/iquantum/${sessionId}`;
  }
}
