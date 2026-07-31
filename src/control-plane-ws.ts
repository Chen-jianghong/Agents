import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { AgentEvent } from "./contracts.js";
import { redactSensitiveValue } from "./event-store.js";
import {
  AgentControlPlane,
  CONTROL_PLANE_VERSION,
  type ControlPlaneFailure,
  type ControlPlaneResponse,
} from "./control-plane.js";

export interface ControlPlaneWebSocketServerOptions {
  host?: string;
  port?: number;
  path?: string;
  maxMessageBytes?: number;
  maxBufferedBytes?: number;
  authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
}

export interface ControlPlaneWebSocketAddress {
  host: string;
  port: number;
  path: string;
}

export interface ControlPlaneWebSocketReadyMessage {
  version: typeof CONTROL_PLANE_VERSION;
  type: "ready";
}

export interface ControlPlaneWebSocketEventMessage {
  version: typeof CONTROL_PLANE_VERSION;
  type: "event";
  data: AgentEvent;
}

export type ControlPlaneWebSocketServerMessage =
  | ControlPlaneWebSocketReadyMessage
  | ControlPlaneWebSocketEventMessage
  | ControlPlaneResponse;

/** WebSocket transport for the transport-neutral Control Plane. */
export class ControlPlaneWebSocketServer {
  private server: Server | undefined;
  private webSocketServer: WebSocketServer | undefined;
  private address: ControlPlaneWebSocketAddress | undefined;
  private readonly connections = new Set<WebSocketConnection>();
  private readonly options: Required<
    Pick<
      ControlPlaneWebSocketServerOptions,
      "host" | "port" | "path" | "maxMessageBytes" | "maxBufferedBytes"
    >
  > & Pick<ControlPlaneWebSocketServerOptions, "authorize">;

  constructor(
    private readonly controlPlane: AgentControlPlane,
    options: ControlPlaneWebSocketServerOptions = {},
  ) {
    const path = options.path ?? "/v1/control-plane/ws";
    if (!path.startsWith("/") || path.includes("?")) {
      throw new Error("Control Plane WebSocket path must be an absolute path without a query string");
    }
    const maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
    const maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
    assertPositiveInteger(maxMessageBytes, "maxMessageBytes");
    assertPositiveInteger(maxBufferedBytes, "maxBufferedBytes");

    this.options = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      path,
      maxMessageBytes,
      maxBufferedBytes,
      ...(options.authorize ? { authorize: options.authorize } : {}),
    };
  }

  async start(): Promise<ControlPlaneWebSocketAddress> {
    if (this.server && this.address) return this.address;

    const server = createServer((request, response) => {
      this.handleHttpRequest(request, response);
    });
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: this.options.maxMessageBytes,
    });
    webSocketServer.on("connection", (socket) => this.handleConnection(socket));
    // Protocol errors are reported on the client connection. Keep malformed
    // upgrade traffic from becoming an unhandled EventEmitter error.
    webSocketServer.on("error", () => undefined);
    server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(server, webSocketServer, request, socket, head).catch(() => {
        if (!socket.destroyed) rejectUpgrade(socket, 500, "WebSocket upgrade failed");
      });
    });

    try {
      await listen(server, this.options.port, this.options.host);
      const rawAddress = server.address();
      if (rawAddress === null || typeof rawAddress === "string") {
        throw new Error("WebSocket server did not expose a TCP address");
      }
      const address = {
        host: this.options.host,
        port: rawAddress.port,
        path: this.options.path,
      };
      this.server = server;
      this.webSocketServer = webSocketServer;
      this.address = address;
      return address;
    } catch (error) {
      webSocketServer.close();
      await closeServer(server);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    const webSocketServer = this.webSocketServer;
    this.server = undefined;
    this.webSocketServer = undefined;
    this.address = undefined;

    if (!server && !webSocketServer) return;

    for (const connection of this.connections) connection.terminate();
    await Promise.all([
      webSocketServer ? closeWebSocketServer(webSocketServer) : Promise.resolve(),
      server ? closeServer(server) : Promise.resolve(),
    ]);
  }

  private handleHttpRequest(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): void {
    if (request.method === "GET" && getPathname(request.url) === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ok", controlPlaneVersion: CONTROL_PLANE_VERSION }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      version: CONTROL_PLANE_VERSION,
      ok: false,
      error: { code: "not_found", message: "Control Plane route not found" },
    } satisfies Omit<ControlPlaneFailure, "requestId"> & { requestId?: string }));
  }

  private async handleUpgrade(
    server: Server,
    webSocketServer: WebSocketServer,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (getPathname(request.url) !== this.options.path) {
      rejectUpgrade(socket, 404, "WebSocket route not found");
      return;
    }

    let authorized = true;
    if (this.options.authorize) {
      try {
        authorized = await this.options.authorize(request);
      } catch {
        authorized = false;
      }
    }
    if (!authorized) {
      rejectUpgrade(socket, 401, "Control Plane authorization failed");
      return;
    }
    if (this.server !== server || this.webSocketServer !== webSocketServer || socket.destroyed) {
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  }

  private handleConnection(socket: WebSocket): void {
    const connection = new WebSocketConnection(
      socket,
      this.options.maxBufferedBytes,
    );
    this.connections.add(connection);
    const cleanup = () => {
      connection.markClosed();
      connection.unsubscribe();
      this.connections.delete(connection);
    };
    connection.setCleanup(cleanup);
    socket.once("close", cleanup);
    socket.once("error", cleanup);

    void connection.send({
      version: CONTROL_PLANE_VERSION,
      type: "ready",
    }).catch(() => connection.terminate());

    connection.setUnsubscribe(this.controlPlane.subscribe((event) => {
      const message: ControlPlaneWebSocketEventMessage = {
        version: CONTROL_PLANE_VERSION,
        type: "event",
        data: redactSensitiveValue(event) as AgentEvent,
      };
      void connection.send(message).catch(() => connection.terminate());
    }));

    socket.on("message", (data: RawData, isBinary: boolean) => {
      void this.handleMessage(connection, data, isBinary).catch(() => connection.terminate());
    });
  }

  private async handleMessage(
    connection: WebSocketConnection,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    const bytes = toBuffer(data);
    if (bytes.length > this.options.maxMessageBytes) {
      connection.close(1009, "Control Plane message is too large");
      return;
    }
    if (isBinary) {
      await connection.send(failure("unknown", "binary_message_not_supported", "Control Plane messages must be text"));
      return;
    }

    let input: unknown;
    try {
      input = JSON.parse(bytes.toString("utf8"));
    } catch {
      await connection.send(failure("unknown", "invalid_json", "Control Plane message must be valid JSON"));
      return;
    }
    const response = await this.controlPlane.handle(input);
    await connection.send(response);
  }
}

class WebSocketConnection {
  private sendQueue: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private closed = false;
  private cleanupHandler: (() => void) | undefined;
  private unsubscribeHandler: (() => void) | undefined;

  constructor(
    private readonly socket: WebSocket,
    private readonly maxBufferedBytes: number,
  ) {}

  setCleanup(handler: () => void): void {
    this.cleanupHandler = handler;
  }

  setUnsubscribe(handler: () => void): void {
    this.unsubscribeHandler = handler;
  }

  unsubscribe(): void {
    this.unsubscribeHandler?.();
    this.unsubscribeHandler = undefined;
  }

  markClosed(): void {
    this.closed = true;
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(code, reason);
    }
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.terminate();
    this.cleanupHandler?.();
  }

  send(message: ControlPlaneWebSocketServerMessage): Promise<boolean> {
    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch {
      return Promise.reject(new Error("Unable to serialize WebSocket message"));
    }
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (
      this.closed
      || bytes > this.maxBufferedBytes
      || this.pendingBytes + this.socket.bufferedAmount + bytes > this.maxBufferedBytes
    ) {
      if (!this.closed) this.close(1013, "Control Plane backpressure");
      return Promise.resolve(false);
    }

    this.pendingBytes += bytes;
    const operation = this.sendQueue.then(() => new Promise<boolean>((resolve) => {
      if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
        resolve(false);
        return;
      }
      this.socket.send(serialized, { binary: false }, (error?: Error) => resolve(error === undefined));
    })).finally(() => {
      this.pendingBytes -= bytes;
    });
    this.sendQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function getPathname(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://control-plane.local").pathname;
  } catch {
    return "/";
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function failure(requestId: string, code: string, message: string): ControlPlaneFailure {
  return {
    version: CONTROL_PLANE_VERSION,
    requestId,
    ok: false,
    error: { code, message },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  if (socket.destroyed) return;
  const reason = statusText(statusCode);
  socket.end(
    `HTTP/1.1 ${statusCode} ${reason}\r\n`
      + "Connection: close\r\n"
      + "Content-Type: text/plain; charset=utf-8\r\n"
      + `Content-Length: ${Buffer.byteLength(message, "utf8")}\r\n`
      + "\r\n"
      + message,
  );
}

function statusText(statusCode: number): string {
  switch (statusCode) {
    case 401:
      return "Unauthorized";
    case 404:
      return "Not Found";
    case 500:
      return "Internal Server Error";
    default:
      return "Error";
  }
}
