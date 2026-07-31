import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { redactSensitiveValue } from "./event-store.js";
import {
  AgentControlPlane,
  CONTROL_PLANE_VERSION,
  type ControlPlaneFailure,
  type ControlPlaneResponse,
} from "./control-plane.js";

export interface ControlPlaneHttpServerOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
}

export interface ControlPlaneHttpAddress {
  host: string;
  port: number;
}

class ControlPlaneHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneHttpError";
  }
}

/** HTTP JSON and SSE transport for the transport-neutral Control Plane. */
export class ControlPlaneHttpServer {
  private server: Server | undefined;
  private address: ControlPlaneHttpAddress | undefined;
  private readonly options: Required<Pick<ControlPlaneHttpServerOptions, "host" | "port" | "maxBodyBytes">>
    & Pick<ControlPlaneHttpServerOptions, "authorize">;

  constructor(
    private readonly controlPlane: AgentControlPlane,
    options: ControlPlaneHttpServerOptions = {},
  ) {
    this.options = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
      ...(options.authorize ? { authorize: options.authorize } : {}),
    };
  }

  async start(): Promise<ControlPlaneHttpAddress> {
    if (this.server && this.address) return this.address;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.writableEnded) writeJson(response, 500, failure("unknown", "http_internal_error", "HTTP transport failed"));
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    const rawAddress = server.address();
    if (rawAddress === null || typeof rawAddress === "string") {
      server.close();
      throw new Error("HTTP server did not expose a TCP address");
    }
    this.server = server;
    this.address = { host: this.options.host, port: rawAddress.port };
    return this.address;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.address = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.options.authorize && !(await this.options.authorize(request))) {
      writeJson(response, 401, failure("unknown", "unauthorized", "Control Plane authorization failed"));
      return;
    }

    const pathname = getPathname(request.url);
    if (request.method === "GET" && pathname === "/healthz") {
      writeJson(response, 200, { status: "ok", controlPlaneVersion: CONTROL_PLANE_VERSION });
      return;
    }
    if (request.method === "GET" && pathname === "/v1/events") {
      this.openEventStream(request, response);
      return;
    }
    if (request.method === "POST" && pathname === "/v1/control-plane") {
      await this.handleCommand(request, response);
      return;
    }
    writeJson(response, 404, failure("unknown", "not_found", "Control Plane route not found"));
  }

  private async handleCommand(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readBody(request, this.options.maxBodyBytes);
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        throw new ControlPlaneHttpError(400, "Request body must be valid JSON");
      }
      const result = await this.controlPlane.handle(input);
      writeJson(response, 200, result);
    } catch (error) {
      if (error instanceof ControlPlaneHttpError) {
        writeJson(response, error.statusCode, failure("unknown", "invalid_http_request", error.message));
        return;
      }
      writeJson(response, 500, failure("unknown", "control_plane_error", "Control Plane request failed"));
    }
  }

  private openEventStream(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ version: CONTROL_PLANE_VERSION })}\n\n`);
    const unsubscribe = this.controlPlane.subscribe((event) => {
      if (response.writableEnded) {
        unsubscribe();
        return;
      }
      try {
        const payload = JSON.stringify(redactSensitiveValue(event));
        response.write(`event: agent\ndata: ${payload}\n\n`);
      } catch {
        response.write("event: error\ndata: {\"code\":\"event_serialization_failed\"}\n\n");
      }
    });
    request.once("close", unsubscribe);
    response.once("close", unsubscribe);
  }
}

function getPathname(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://control-plane.local").pathname;
  } catch {
    return "/";
  }
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        request.removeAllListeners("data");
        request.resume();
        reject(new ControlPlaneHttpError(413, "Request body is too large"));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => reject(new ControlPlaneHttpError(400, "Unable to read request body")));
  });
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function failure(requestId: string, code: string, message: string): ControlPlaneFailure {
  return {
    version: CONTROL_PLANE_VERSION,
    requestId,
    ok: false,
    error: { code, message },
  };
}
