import { randomBytes } from "node:crypto";
import { mkdirSync, chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const IPC_PROTOCOL_VERSION = 1;
export const MAX_IPC_FRAME_BYTES = 1024 * 1024;

export interface IpcEnvelope {
  version: typeof IPC_PROTOCOL_VERSION;
  type: string;
  childId: string;
  sequence: number;
  payload?: unknown;
  token?: string;
}

export function createIpcToken(): string {
  return randomBytes(32).toString("hex");
}

export function getIpcSocketPath(parentSessionId: string, pid = process.pid): string {
  const runtimeRoot = process.env.XDG_RUNTIME_DIR ?? tmpdir();
  const dir = join(runtimeRoot, "pi-subagents");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  const safeSessionId = parentSessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  return join(dir, `${safeSessionId || "session"}-${pid}.sock`);
}

export function encodeIpcFrame(message: IpcEnvelope): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_IPC_FRAME_BYTES) {
    throw new Error(`IPC frame exceeds ${MAX_IPC_FRAME_BYTES} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class IpcFrameDecoder {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer | string): IpcEnvelope[] {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
    const messages: IpcEnvelope[] = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_IPC_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0);
        throw new Error(`IPC frame exceeds ${MAX_IPC_FRAME_BYTES} bytes`);
      }
      if (this.buffer.length < 4 + length) break;

      const raw = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      const parsed = JSON.parse(raw) as IpcEnvelope;
      if (
        parsed.version !== IPC_PROTOCOL_VERSION ||
        typeof parsed.type !== "string" ||
        typeof parsed.childId !== "string" ||
        typeof parsed.sequence !== "number"
      ) {
        throw new Error("Malformed or unsupported IPC message");
      }
      messages.push(parsed);
    }

    return messages;
  }
}

interface ParentIpcServerOptions {
  socketPath: string;
  onMessage: (message: IpcEnvelope) => void;
  onConnect?: (childId: string) => void;
  onDisconnect?: (childId: string) => void;
}

export class ParentIpcServer {
  private server: Server | null = null;
  private credentials = new Map<string, string>();
  private clients = new Map<string, Socket>();
  private sequence = 0;
  private readonly options: ParentIpcServerOptions;

  constructor(options: ParentIpcServerOptions) {
    this.options = options;
  }

  registerChild(childId: string, token: string): void {
    this.credentials.set(childId, token);
  }

  unregisterChild(childId: string): void {
    this.credentials.delete(childId);
    const socket = this.clients.get(childId);
    this.clients.delete(childId);
    socket?.destroy();
  }

  async start(): Promise<void> {
    if (this.server) return;
    rmSync(this.options.socketPath, { force: true });

    this.server = createServer((socket) => {
      const decoder = new IpcFrameDecoder();
      let authenticatedChildId: string | null = null;

      socket.on("data", (chunk) => {
        try {
          for (const message of decoder.push(chunk)) {
            if (!authenticatedChildId) {
              const expected = this.credentials.get(message.childId);
              if (message.type !== "hello" || !expected || message.token !== expected) {
                socket.destroy(new Error("IPC authentication failed"));
                return;
              }
              authenticatedChildId = message.childId;
              const previous = this.clients.get(message.childId);
              if (previous && previous !== socket) previous.destroy();
              this.clients.set(message.childId, socket);
              this.send(message.childId, "welcome", { parentPid: process.pid });
              this.options.onConnect?.(message.childId);
            }

            if (message.childId !== authenticatedChildId) {
              socket.destroy(new Error("IPC child identity changed"));
              return;
            }
            this.options.onMessage(message);
          }
        } catch (error) {
          socket.destroy(error as Error);
        }
      });

      socket.on("close", () => {
        if (authenticatedChildId && this.clients.get(authenticatedChildId) === socket) {
          this.clients.delete(authenticatedChildId);
          this.options.onDisconnect?.(authenticatedChildId);
        }
      });
      socket.on("error", () => {});
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.socketPath);
    });
    try {
      chmodSync(this.options.socketPath, 0o600);
    } catch {}
  }

  send(childId: string, type: string, payload?: unknown): boolean {
    const socket = this.clients.get(childId);
    if (!socket || socket.destroyed) return false;
    socket.write(
      encodeIpcFrame({
        version: IPC_PROTOCOL_VERSION,
        type,
        childId,
        sequence: ++this.sequence,
        payload,
      }),
    );
    return true;
  }

  isConnected(childId: string): boolean {
    return !!this.clients.get(childId) && !this.clients.get(childId)!.destroyed;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.clients.values()) socket.destroy();
    this.clients.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(this.options.socketPath, { force: true });
  }
}

interface ChildIpcClientOptions {
  socketPath: string;
  childId: string;
  token: string;
  helloPayload: () => unknown;
  onMessage?: (message: IpcEnvelope) => void;
  reconnectDelayMs?: number;
}

export class ChildIpcClient {
  private socket: Socket | null = null;
  private decoder = new IpcFrameDecoder();
  private sequence = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Buffer[] = [];
  private readonly options: ChildIpcClientOptions;

  constructor(options: ChildIpcClientOptions) {
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    const socket = createConnection(this.options.socketPath);
    this.socket = socket;
    this.decoder = new IpcFrameDecoder();

    socket.once("connect", () => {
      socket.write(
        encodeIpcFrame({
          version: IPC_PROTOCOL_VERSION,
          type: "hello",
          childId: this.options.childId,
          token: this.options.token,
          sequence: ++this.sequence,
          payload: this.options.helloPayload(),
        }),
      );
      for (const frame of this.queue.splice(0)) socket.write(frame);
    });

    socket.on("data", (chunk) => {
      try {
        for (const message of this.decoder.push(chunk)) this.options.onMessage?.(message);
      } catch {
        socket.destroy();
      }
    });

    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(
          () => this.connect(),
          this.options.reconnectDelayMs ?? 500,
        );
      }
    });
    socket.on("error", () => {});
  }

  send(type: string, payload?: unknown): void {
    const frame = encodeIpcFrame({
      version: IPC_PROTOCOL_VERSION,
      type,
      childId: this.options.childId,
      sequence: ++this.sequence,
      payload,
    });
    if (this.socket?.readyState === "open") this.socket.write(frame);
    else {
      this.queue.push(frame);
      if (this.queue.length > 100) this.queue.shift();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.destroy();
    this.socket = null;
  }
}
