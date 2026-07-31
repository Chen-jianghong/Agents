import { Readable, Writable } from "node:stream";
import type { AgentEvent } from "./contracts.js";
import { redactSensitiveValue } from "./event-store.js";
import {
  AgentControlPlane,
  CONTROL_PLANE_VERSION,
  type ControlPlaneFailure,
  type ControlPlaneRequest,
  type ControlPlaneResponse,
} from "./control-plane.js";

export interface ControlPlaneWorkerRpcServerOptions {
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
  authorize?: (token: string | undefined) => boolean | Promise<boolean>;
}

export interface ControlPlaneWorkerRpcClientOptions {
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
  token?: string;
}

export interface ControlPlaneWorkerRpcReadyFrame {
  version: typeof CONTROL_PLANE_VERSION;
  type: "ready";
  authenticated: boolean;
}

export interface ControlPlaneWorkerRpcAuthenticateFrame {
  version: typeof CONTROL_PLANE_VERSION;
  type: "authenticate";
  requestId: string;
  token?: string;
}

export interface ControlPlaneWorkerRpcAuthenticatedFrame {
  version: typeof CONTROL_PLANE_VERSION;
  type: "authenticated";
  requestId: string;
}

export interface ControlPlaneWorkerRpcEventFrame {
  version: typeof CONTROL_PLANE_VERSION;
  type: "event";
  data: AgentEvent;
}

export type ControlPlaneWorkerRpcFrame =
  | ControlPlaneWorkerRpcReadyFrame
  | ControlPlaneWorkerRpcAuthenticateFrame
  | ControlPlaneWorkerRpcAuthenticatedFrame
  | ControlPlaneWorkerRpcEventFrame
  | ControlPlaneRequest
  | ControlPlaneResponse;

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * JSONL adapter for a Pi Worker process. Each input line is a v1 Control
 * Plane request; responses use the same requestId and events are pushed as
 * `type: "event"` frames. Pi Session objects never cross this boundary.
 */
export class ControlPlaneWorkerRpcServer {
  private readonly reader: JsonlFrameReader;
  private readonly writer: JsonlFrameWriter;
  private readonly options: Required<Pick<ControlPlaneWorkerRpcServerOptions, "maxFrameBytes" | "maxBufferedBytes">>
    & Pick<ControlPlaneWorkerRpcServerOptions, "authorize">;
  private started = false;
  private stopped = false;
  private authenticated: boolean;
  private requestQueue: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.stopped) return;
    try {
      for (const line of this.reader.push(chunk)) this.enqueueLine(line);
    } catch (error) {
      void this.failTransport(error instanceof WorkerRpcProtocolError ? error.code : "frame_too_large");
    }
  };

  private readonly onEnd = (): void => {
    if (this.stopped) return;
    try {
      for (const line of this.reader.finish()) this.enqueueLine(line);
    } catch {
      void this.failTransport("frame_too_large");
      return;
    }
    void this.stop();
  };

  private readonly onInputError = (): void => {
    void this.stop();
  };

  constructor(
    private readonly controlPlane: AgentControlPlane,
    private readonly input: Readable,
    private readonly output: Writable,
    options: ControlPlaneWorkerRpcServerOptions = {},
  ) {
    const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    assertPositiveInteger(maxFrameBytes, "maxFrameBytes");
    assertPositiveInteger(maxBufferedBytes, "maxBufferedBytes");
    this.options = {
      maxFrameBytes,
      maxBufferedBytes,
      ...(options.authorize ? { authorize: options.authorize } : {}),
    };
    this.authenticated = !options.authorize;
    this.reader = new JsonlFrameReader(maxFrameBytes);
    this.writer = new JsonlFrameWriter(
      output,
      maxFrameBytes,
      maxBufferedBytes,
      () => void this.failTransport("rpc_backpressure"),
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.input.on("data", this.onData);
    this.input.once("end", this.onEnd);
    this.input.once("error", this.onInputError);
    this.unsubscribe = this.controlPlane.subscribe((event) => {
      const frame: ControlPlaneWorkerRpcEventFrame = {
        version: CONTROL_PLANE_VERSION,
        type: "event",
        data: redactSensitiveValue(event) as AgentEvent,
      };
      void this.writer.send(frame);
    });
    void this.writer.send({
      version: CONTROL_PLANE_VERSION,
      type: "ready",
      authenticated: this.authenticated,
    } satisfies ControlPlaneWorkerRpcReadyFrame);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("error", this.onInputError);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.writer.close();
    await endWritable(this.output);
  }

  private enqueueLine(line: string): void {
    this.requestQueue = this.requestQueue
      .then(() => this.handleLine(line))
      .catch(() => undefined);
  }

  private async handleLine(line: string): Promise<void> {
    if (this.stopped) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      await this.writer.send(failure("unknown", "invalid_json", "Worker RPC frame must be valid JSON"));
      return;
    }
    if (!isObject(value)) {
      await this.writer.send(failure("unknown", "invalid_request", "Worker RPC frame must be an object"));
      return;
    }
    const frame = value as Record<string, unknown>;
    const requestId = getRequestId(frame);
    if (frame.version !== CONTROL_PLANE_VERSION) {
      await this.writer.send(failure(requestId, "unsupported_version", "Unsupported Control Plane version"));
      return;
    }

    if (frame.type === "authenticate") {
      await this.handleAuthentication(frame, requestId);
      return;
    }
    if (!this.authenticated) {
      await this.writer.send(failure(requestId, "authentication_required", "Worker RPC authentication is required"));
      return;
    }
    const response = await this.controlPlane.handle(value);
    await this.writer.send(response);
  }

  private async handleAuthentication(frame: Record<string, unknown>, requestId: string): Promise<void> {
    if (!this.options.authorize) {
      await this.writer.send(failure(requestId, "unknown_command", "Worker RPC authentication is not enabled"));
      return;
    }
    if (typeof frame.token !== "undefined" && typeof frame.token !== "string") {
      await this.writer.send(failure(requestId, "invalid_request", "Authentication token must be a string"));
      await this.stop();
      return;
    }
    let allowed = false;
    try {
      allowed = await this.options.authorize(frame.token as string | undefined);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      await this.writer.send(failure(requestId, "unauthorized", "Worker RPC authorization failed"));
      await this.stop();
      return;
    }
    this.authenticated = true;
    await this.writer.send({
      version: CONTROL_PLANE_VERSION,
      type: "authenticated",
      requestId,
    } satisfies ControlPlaneWorkerRpcAuthenticatedFrame);
  }

  private async failTransport(code: string): Promise<void> {
    if (this.stopped) return;
    if (code !== "rpc_backpressure") {
      await this.writer.send(failure("unknown", code, "Worker RPC transport closed"));
    }
    await this.stop();
  }
}

/** Stream client for ControlPlaneWorkerRpcServer, suitable for a parent process. */
export class ControlPlaneWorkerRpcClient {
  private readonly reader: JsonlFrameReader;
  private readonly writer: JsonlFrameWriter;
  private readonly token: string | undefined;
  private started = false;
  private stopped = false;
  private authenticated = false;
  private authRequestId = "";
  private requestSequence = 0;
  private frameQueue: Promise<void> = Promise.resolve();
  private startResolve: (() => void) | undefined;
  private startReject: ((error: Error) => void) | undefined;
  private readonly pending = new Map<string, {
    resolve: (response: ControlPlaneResponse) => void;
    reject: (error: Error) => void;
  }>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.stopped) return;
    try {
      for (const line of this.reader.push(chunk)) this.enqueueLine(line);
    } catch {
      this.fail(new Error("Worker RPC frame is too large"));
    }
  };

  private readonly onEnd = (): void => {
    if (this.stopped) return;
    try {
      for (const line of this.reader.finish()) this.enqueueLine(line);
    } catch {
      this.fail(new Error("Worker RPC frame is too large"));
      return;
    }
    this.fail(new Error("Worker RPC stream closed"));
  };

  private readonly onInputError = (error: Error): void => this.fail(error);

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    options: ControlPlaneWorkerRpcClientOptions = {},
  ) {
    const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    assertPositiveInteger(maxFrameBytes, "maxFrameBytes");
    assertPositiveInteger(maxBufferedBytes, "maxBufferedBytes");
    this.token = options.token;
    this.reader = new JsonlFrameReader(maxFrameBytes);
    this.writer = new JsonlFrameWriter(output, maxFrameBytes, maxBufferedBytes, () => {
      this.fail(new Error("Worker RPC backpressure limit exceeded"));
    });
  }

  start(): Promise<void> {
    if (this.started) return this.startPromise;
    this.startPromiseValue = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    this.started = true;
    this.input.on("data", this.onData);
    this.input.once("end", this.onEnd);
    this.input.once("error", this.onInputError);
    return this.startPromise;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(request: ControlPlaneRequest): Promise<ControlPlaneResponse> {
    if (!this.started) throw new Error("Worker RPC client must be started before request");
    if (this.stopped || !this.authenticated) throw new Error("Worker RPC client is not authenticated");
    if (this.pending.has(request.requestId)) throw new Error(`Duplicate Worker RPC requestId: ${request.requestId}`);
    const response = new Promise<ControlPlaneResponse>((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject });
    });
    // fail() may reject this promise while send() is still awaiting the
    // output write. Attach a no-op handler so that rejection never hits the
    // unhandled-rejection window before the caller awaits the response.
    void response.catch(() => undefined);
    const sent = await this.writer.send(request);
    if (!sent) {
      this.pending.delete(request.requestId);
      throw new Error("Unable to send Worker RPC request");
    }
    return response;
  }

  async stop(): Promise<void> {
    this.fail(new Error("Worker RPC client stopped"));
    await endWritable(this.output);
  }

  private enqueueLine(line: string): void {
    this.frameQueue = this.frameQueue
      .then(() => this.handleLine(line))
      .catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
  }

  private async handleLine(line: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.fail(new Error("Worker RPC frame must be valid JSON"));
      return;
    }
    if (!isObject(value) || value.version !== CONTROL_PLANE_VERSION) {
      this.fail(new Error("Invalid Worker RPC frame"));
      return;
    }
    const frame = value as Record<string, unknown>;
    if (frame.type === "ready") {
      if (frame.authenticated === true) {
        this.authenticated = true;
        this.resolveStart();
        return;
      }
      this.authRequestId = `rpc-auth-${++this.requestSequence}`;
      const authFrame: ControlPlaneWorkerRpcAuthenticateFrame = {
        version: CONTROL_PLANE_VERSION,
        type: "authenticate",
        requestId: this.authRequestId,
        ...(this.token !== undefined ? { token: this.token } : {}),
      };
      const sent = await this.writer.send(authFrame);
      if (!sent) this.fail(new Error("Unable to send Worker RPC authentication"));
      return;
    }
    if (frame.type === "authenticated") {
      if (frame.requestId !== this.authRequestId) {
        this.fail(new Error("Unexpected Worker RPC authentication response"));
        return;
      }
      this.authenticated = true;
      this.resolveStart();
      return;
    }
    if (frame.type === "event") {
      if (!isObject(frame.data)) return;
      for (const listener of this.listeners) {
        try {
          listener(frame.data as unknown as AgentEvent);
        } catch {
          // A client event listener must not tear down the RPC stream.
        }
      }
      return;
    }
    if (typeof frame.requestId !== "string" || typeof frame.ok !== "boolean") {
      this.fail(new Error("Invalid Worker RPC response"));
      return;
    }
    if (!this.authenticated && frame.requestId === this.authRequestId && frame.ok === false) {
      const message = isObject(frame.error) && typeof frame.error.message === "string"
        ? frame.error.message
        : "Worker RPC authentication failed";
      this.fail(new Error(message));
      return;
    }
    const pending = this.pending.get(frame.requestId);
    if (!pending) return;
    this.pending.delete(frame.requestId);
    pending.resolve(frame as unknown as ControlPlaneResponse);
  }

  private resolveStart(): void {
    this.startResolve?.();
    this.startResolve = undefined;
    this.startReject = undefined;
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("error", this.onInputError);
    this.writer.close();
    this.startReject?.(error);
    this.startResolve = undefined;
    this.startReject = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private get startPromise(): Promise<void> {
    return this.startPromiseValue ?? Promise.reject(new Error("Worker RPC client start was not initialized"));
  }

  private startPromiseValue: Promise<void> | undefined;
}

class JsonlFrameReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Buffer | string): string[] {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);
    return this.readLines();
  }

  finish(): string[] {
    if (this.buffer.length === 0) return [];
    if (this.buffer.length > this.maxFrameBytes) throw new WorkerRpcProtocolError("frame_too_large");
    const line = this.buffer.toString("utf8").replace(/\r$/, "");
    this.buffer = Buffer.alloc(0);
    return line.trim().length > 0 ? [line] : [];
  }

  private readLines(): string[] {
    const lines: string[] = [];
    let newline = this.buffer.indexOf(0x0a);
    while (newline >= 0) {
      if (newline > this.maxFrameBytes) throw new WorkerRpcProtocolError("frame_too_large");
      const line = this.buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.trim().length > 0) lines.push(line);
      newline = this.buffer.indexOf(0x0a);
    }
    if (this.buffer.length > this.maxFrameBytes) throw new WorkerRpcProtocolError("frame_too_large");
    return lines;
  }
}

class JsonlFrameWriter {
  private queue: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private closed = false;

  constructor(
    private readonly output: Writable,
    private readonly maxFrameBytes: number,
    private readonly maxBufferedBytes: number,
    private readonly onBackpressure: () => void,
  ) {}

  close(): void {
    this.closed = true;
  }

  send(frame: unknown): Promise<boolean> {
    let line: string;
    try {
      line = `${JSON.stringify(frame)}\n`;
    } catch {
      return Promise.reject(new Error("Unable to serialize Worker RPC frame"));
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (
      this.closed
      || bytes > this.maxFrameBytes
      || this.pendingBytes + this.output.writableLength + bytes > this.maxBufferedBytes
    ) {
      if (!this.closed) this.onBackpressure();
      return Promise.resolve(false);
    }

    this.pendingBytes += bytes;
    const operation = this.queue.then(() => this.write(line)).finally(() => {
      this.pendingBytes -= bytes;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private write(line: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let callbackDone = false;
      let drained = true;
      let settled = false;
      const onDrain = () => {
        drained = true;
        finish();
      };
      const onError = (error: Error) => {
        cleanup();
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const finish = () => {
        if (!callbackDone || !drained || settled) return;
        settled = true;
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        this.output.off("drain", onDrain);
        this.output.off("error", onError);
      };

      this.output.once("error", onError);
      try {
        drained = this.output.write(line, "utf8", (error: Error | null | undefined) => {
          callbackDone = true;
          if (error) {
            onError(error);
            return;
          }
          finish();
        });
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!drained) this.output.once("drain", onDrain);
      finish();
    });
  }
}

class WorkerRpcProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkerRpcProtocolError";
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRequestId(value: Record<string, unknown>): string {
  return typeof value.requestId === "string" && value.requestId.trim().length > 0
    ? value.requestId
    : "unknown";
}

function failure(requestId: string, code: string, message: string): ControlPlaneFailure {
  return {
    version: CONTROL_PLANE_VERSION,
    requestId,
    ok: false,
    error: { code, message },
  };
}

function endWritable(output: Writable): Promise<void> {
  if (output.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    output.end(() => resolve());
  });
}
