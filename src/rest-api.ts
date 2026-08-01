/**
 * REST API for the Multi-Agent runtime (project plan Phase 5).
 *
 * Thin, transport-facing layer over the transport-neutral AgentControlPlane:
 * every route is translated into a v1 Control Plane command, so the same
 * validation and host security boundaries (workspace matching, depth limits,
 * host execution defaults) apply. Success responses carry the command's
 * `data` directly; failures carry `{ error: { code, message } }` with an
 * HTTP status derived from the error code.
 */
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
  type ControlPlaneResponse,
} from "./control-plane.js";
import type { AgentTaskFilter, AgentTaskRecordStatus } from "./task-store.js";
import type { AgentTask } from "./contracts.js";
import type { ModelConfigService, ProviderInput, ModelProfileInput } from "./model-config-service.js";

export interface MultiAgentRestApiServerOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
  /** Workspace used when POST /api/runs omits `workspace`. */
  defaultWorkspace?: string;
  /** Model configuration center endpoints (/api/model/*). */
  modelConfig?: ModelConfigService;
}

export interface RestApiAddress {
  host: string;
  port: number;
}

class RestApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "RestApiError";
  }
}

/** REST API surface over the Control Plane. */
export class MultiAgentRestApiServer {
  private server: Server | undefined;
  private address: RestApiAddress | undefined;
  private readonly options: Required<Pick<MultiAgentRestApiServerOptions, "host" | "port" | "maxBodyBytes">>
    & Pick<MultiAgentRestApiServerOptions, "authorize" | "defaultWorkspace" | "modelConfig">;

  constructor(
    private readonly controlPlane: AgentControlPlane,
    options: MultiAgentRestApiServerOptions = {},
  ) {
    this.options = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
      ...(options.authorize ? { authorize: options.authorize } : {}),
      ...(options.defaultWorkspace !== undefined ? { defaultWorkspace: options.defaultWorkspace } : {}),
      ...(options.modelConfig ? { modelConfig: options.modelConfig } : {}),
    };
  }

  async start(): Promise<RestApiAddress> {
    if (this.server && this.address) return this.address;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.writableEnded) {
          writeJson(response, 500, { error: { code: "internal_error", message: "REST API request failed" } });
        }
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
      throw new Error("REST API server did not expose a TCP address");
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
      writeJson(response, 401, { error: { code: "unauthorized", message: "REST API authorization failed" } });
      return;
    }

    const { pathname, query } = parseUrl(request.url);
    const segments = pathname.split("/").filter(Boolean); // e.g. ["api", "runs", "run_1"]

    try {
      if (request.method === "GET" && pathname === "/api/health") {
        writeJson(response, 200, { status: "ok", controlPlaneVersion: CONTROL_PLANE_VERSION });
        return;
      }
      if (request.method === "GET" && pathname === "/ui/vendors") {
        this.serveVendorForm(response);
        return;
      }
      if (segments[0] !== "api") {
        throw new RestApiError(404, "Route not found");
      }
      switch (segments[1]) {
        case "profiles":
          if (request.method !== "GET" || segments.length !== 2) throw new RestApiError(404, "Route not found");
          await this.reply(response, await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "list_profiles" }));
          return;
        case "runs":
          await this.handleRuns(request, response, segments, query);
          return;
        case "agents":
          await this.handleAgents(request, response, segments, query);
          return;
        case "model":
          await this.handleModel(request, response, segments);
          return;
        default:
          throw new RestApiError(404, "Route not found");
      }
    } catch (error) {
      if (error instanceof RestApiError) {
        writeJson(response, error.statusCode, { error: { code: "not_found", message: error.message } });
        return;
      }
      writeJson(response, 500, { error: { code: "internal_error", message: "REST API request failed" } });
    }
  }

  private async handleRuns(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
    query: URLSearchParams,
  ): Promise<void> {
    if (segments.length === 2) {
      if (request.method === "GET") {
        await this.reply(response, await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "list_runs" }));
        return;
      }
      if (request.method === "POST") {
        const body = await readJsonBody(request, this.options.maxBodyBytes);
        const goal = requireField(body, "goal");
        const workspace = typeof body.workspace === "string"
          ? body.workspace
          : this.options.defaultWorkspace;
        if (workspace === undefined) {
          throw new RestApiError(422, "workspace is required (no default workspace configured)");
        }
        await this.reply(response, await this.controlPlane.handle({
          version: "v1",
          requestId: nextRequestId(),
          type: "create_run",
          goal,
          workspace,
          ...(body.maxParallel !== undefined ? { maxParallel: body.maxParallel } : {}),
          ...(body.plannerModelProfile !== undefined ? { plannerModelProfile: body.plannerModelProfile } : {}),
        }));
        return;
      }
      throw new RestApiError(405, "Method not allowed");
    }

    const runId = decodeSegment(segments[2]!);
    if (segments.length === 3) {
      if (request.method === "GET") {
        const result = await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "get_run", runId });
        if (result.ok && result.data === null) {
          writeJson(response, 404, { error: { code: "run_not_found", message: `Run ${runId} was not found` } });
          return;
        }
        await this.reply(response, result);
        return;
      }
      throw new RestApiError(405, "Method not allowed");
    }

    const action = segments[3];
    switch (action) {
      case "start":
        requireMethod(request, "POST");
        await this.reply(response, await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "start_run", runId }));
        return;
      case "cancel":
        requireMethod(request, "POST");
        await this.reply(response, await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "cancel_run", runId }));
        return;
      case "pause":
        requireMethod(request, "POST");
        await this.reply(response, await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "pause_run", runId }));
        return;
      case "resume":
        requireMethod(request, "POST");
        await this.reply(response, await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "resume_run", runId }));
        return;
      case "retry":
        requireMethod(request, "POST");
        await this.reply(response, await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "retry_run", runId }));
        return;
      case "graph":
      case "tasks":
        requireMethod(request, "GET");
        await this.replyRunSubresource(response, runId, action === "graph" ? "dag" : "tasks");
        return;
      case "events":
        requireMethod(request, "GET");
        if (segments.length === 5 && segments[4] === "history") {
          await this.reply(response, await this.controlPlane.handle({
            version: "v1",
            requestId: nextRequestId(),
            type: "list_events",
            filter: { runId },
          }));
          return;
        }
        this.openRunEventStream(request, response, runId);
        return;
      default:
        throw new RestApiError(404, "Route not found");
    }
  }

  private async replyRunSubresource(
    response: ServerResponse,
    runId: string,
    field: "dag" | "tasks",
  ): Promise<void> {
    const snapshot = await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "get_run", runId });
    if (!snapshot.ok) {
      writeControlPlaneFailure(response, snapshot);
      return;
    }
    const data = snapshot.data as { dag?: unknown; tasks?: unknown };
    writeJson(response, 200, field === "dag" ? (data.dag ?? null) : (data.tasks ?? []));
  }

  private async handleAgents(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
    query: URLSearchParams,
  ): Promise<void> {
    if (segments.length === 2) {
      requireMethod(request, "GET");
      await this.listAgentTasks(response, query);
      return;
    }

    if (segments[2] === "run" && segments.length === 3 && request.method === "POST") {
      const body = await readJsonBody(request, this.options.maxBodyBytes);
      const profileId = requireField(body, "profileId");
      const task = body.task as AgentTask | undefined;
      if (typeof task !== "object" || task === null) {
        throw new RestApiError(422, "task is required");
      }
      await this.reply(response, await this.controlPlane.handle({
        version: "v1",
        requestId: nextRequestId(),
        type: "run_agent",
        profileId,
        task,
      }));
      return;
    }

    if (segments[2] === "tasks") {
      if (segments.length === 3) {
        requireMethod(request, "GET");
        await this.listAgentTasks(response, query);
        return;
      }
      if (segments.length === 4) {
        const agentTaskId = decodeSegment(segments[3]!);
        requireMethod(request, "GET");
        await this.reply(response, await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "get_task", agentTaskId }));
        return;
      }
      if (segments.length === 5 && segments[4] === "retry") {
        const agentTaskId = decodeSegment(segments[3]!);
        requireMethod(request, "POST");
        await this.reply(response, await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "retry_agent", agentTaskId }));
        return;
      }
      throw new RestApiError(404, "Route not found");
    }

    if (segments[2] === "results" && segments.length === 4 && request.method === "GET") {
      const agentTaskId = decodeSegment(segments[3]!);
      await this.reply(response, await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "get_result", agentTaskId }));
      return;
    }

    if (segments.length === 4 && segments[3] === "cancel" && request.method === "POST") {
      const agentId = decodeSegment(segments[2]!);
      await this.reply(response, await this.controlPlane.handle({ version: "v1", requestId: nextRequestId(), type: "cancel_agent", agentId }));
      return;
    }

    throw new RestApiError(404, "Route not found");
  }

  private async handleModel(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
  ): Promise<void> {
    const modelConfig = this.options.modelConfig;
    if (!modelConfig) {
      throw new RestApiError(503, "Model configuration center is not configured");
    }
    if (segments.length < 3) throw new RestApiError(404, "Route not found");

    const resource = segments[2];
    switch (resource) {
      case "providers":
        await this.handleModelProviders(request, response, modelConfig, segments);
        return;
      case "profiles":
        await this.handleModelProfiles(request, response, modelConfig, segments);
        return;
      case "role-bindings":
        await this.handleRoleBindings(request, response, modelConfig, segments);
        return;
      case "vendors":
        if (segments.length === 3) {
          requireMethod(request, "POST");
          const body = await readJsonBody(request, this.options.maxBodyBytes);
          try {
            const result = await modelConfig.addVendor(body as unknown as Parameters<typeof modelConfig.addVendor>[0]);
            writeJson(response, 200, result);
          } catch (error) {
            if (error instanceof Error && error.name === "ModelConfigValidationError") {
              throw new RestApiError(422, error.message);
            }
            throw error;
          }
          return;
        }
        throw new RestApiError(404, "Route not found");
      default:
        throw new RestApiError(404, "Route not found");
    }
  }

  private async handleModelProviders(
    request: IncomingMessage,
    response: ServerResponse,
    modelConfig: ModelConfigService,
    segments: string[],
  ): Promise<void> {
    if (segments.length === 3) {
      requireMethod(request, "GET");
      writeJson(response, 200, modelConfig.listProviders());
      return;
    }
    if (segments.length === 4) {
      const providerId = decodeSegment(segments[3]!);
      if (request.method === "GET") {
        const provider = modelConfig.getProvider(providerId);
        if (!provider) throw new RestApiError(404, "Provider not found");
        writeJson(response, 200, provider);
        return;
      }
      if (request.method === "PUT") {
        const body = await readJsonBody(request, this.options.maxBodyBytes);
        const input: ProviderInput = { ...body, id: providerId } as ProviderInput;
        try {
          const saved = await modelConfig.upsertProvider(input);
          writeJson(response, 200, saved);
        } catch (error) {
          if (error instanceof Error && error.name === "ModelConfigValidationError") {
            throw new RestApiError(422, error.message);
          }
          throw error;
        }
        return;
      }
      if (request.method === "DELETE") {
        await modelConfig.removeProvider(providerId);
        writeJson(response, 200, { deleted: providerId });
        return;
      }
      throw new RestApiError(405, "Method not allowed");
    }
    throw new RestApiError(404, "Route not found");
  }

  private async handleModelProfiles(
    request: IncomingMessage,
    response: ServerResponse,
    modelConfig: ModelConfigService,
    segments: string[],
  ): Promise<void> {
    if (segments.length === 3) {
      requireMethod(request, "GET");
      writeJson(response, 200, modelConfig.listModelProfiles());
      return;
    }
    if (segments.length === 4) {
      const profileName = decodeSegment(segments[3]!);
      if (request.method === "GET") {
        const profile = modelConfig.getModelProfile(profileName);
        if (!profile) throw new RestApiError(404, "Model profile not found");
        writeJson(response, 200, profile);
        return;
      }
      if (request.method === "PUT") {
        const body = await readJsonBody(request, this.options.maxBodyBytes);
        const input: ModelProfileInput = { ...body, name: profileName } as ModelProfileInput;
        try {
          const saved = await modelConfig.upsertModelProfile(input);
          writeJson(response, 200, saved);
        } catch (error) {
          if (error instanceof Error && error.name === "ModelConfigValidationError") {
            throw new RestApiError(422, error.message);
          }
          throw error;
        }
        return;
      }
      if (request.method === "DELETE") {
        await modelConfig.removeModelProfile(profileName);
        writeJson(response, 200, { deleted: profileName });
        return;
      }
      throw new RestApiError(405, "Method not allowed");
    }
    throw new RestApiError(404, "Route not found");
  }

  private async handleRoleBindings(
    request: IncomingMessage,
    response: ServerResponse,
    modelConfig: ModelConfigService,
    segments: string[],
  ): Promise<void> {
    if (segments.length === 3) {
      requireMethod(request, "GET");
      writeJson(response, 200, modelConfig.listRoleBindings());
      return;
    }
    if (segments.length === 4) {
      const role = decodeSegment(segments[3]!);
      if (request.method === "GET") {
        const binding = modelConfig.getRoleBinding(role);
        if (!binding) throw new RestApiError(404, "Role binding not found");
        writeJson(response, 200, binding);
        return;
      }
      if (request.method === "PUT") {
        const body = await readJsonBody(request, this.options.maxBodyBytes);
        const modelProfileId = requireField(body, "modelProfileId");
        const fallback = typeof body.fallbackModelProfileId === "string"
          ? body.fallbackModelProfileId
          : undefined;
        try {
          const saved = await modelConfig.setRoleBinding(role, modelProfileId, fallback);
          writeJson(response, 200, saved);
        } catch (error) {
          if (error instanceof Error && error.name === "ModelConfigValidationError") {
            throw new RestApiError(422, error.message);
          }
          throw error;
        }
        return;
      }
      if (request.method === "DELETE") {
        await modelConfig.removeRoleBinding(role);
        writeJson(response, 200, { deleted: role });
        return;
      }
      throw new RestApiError(405, "Method not allowed");
    }
    throw new RestApiError(404, "Route not found");
  }

  /** Simple built-in HTML form for manual vendor registration (/ui/vendors). */
  private serveVendorForm(response: ServerResponse): void {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>添加供应商 - Multi-Agent Dev</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color: #1f2933; }
  h1 { font-size: 20px; }
  label { display: block; margin: 12px 0 4px; font-size: 13px; color: #52606d; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #cbd2d9; border-radius: 6px; font-size: 14px; }
  button { margin-top: 18px; padding: 10px 16px; background: #2563eb; color: #fff; border: 0; border-radius: 6px; font-size: 14px; cursor: pointer; }
  button:disabled { opacity: .6; }
  #result { margin-top: 16px; font-size: 13px; white-space: pre-wrap; }
  .ok { color: #0a7d33; } .err { color: #b91c1c; }
</style>
</head>
<body>
<h1>手动添加供应商</h1>
<form id="form">
  <label>供应商名称 *</label>
  <input name="name" required placeholder="如 DeepSeek">
  <label>API 地址</label>
  <input name="baseUrl" placeholder="如 https://api.deepseek.com">
  <label>API Key</label>
  <input name="apiKey" type="password" placeholder="sk-...（存 SecretStore，不落盘明文）">
  <label>模型名称 *</label>
  <input name="modelName" required placeholder="如 deepseek-chat">
  <label>上下文（tokens）</label>
  <input name="contextWindow" type="number" min="1" placeholder="如 65536">
  <button type="submit">添加</button>
</form>
<div id="result"></div>
<script>
const form = document.getElementById("form");
const result = document.getElementById("result");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  result.className = "";
  result.textContent = "提交中...";
  const payload = {};
  for (const el of form.elements) {
    if (el.name && el.value.trim() !== "") payload[el.name] = el.value;
  }
  if (payload.contextWindow) payload.contextWindow = Number(payload.contextWindow);
  try {
    const response = await fetch("/api/model/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) {
      result.className = "err";
      result.textContent = "添加失败: " + (body.error?.message ?? response.status);
      return;
    }
    result.className = "ok";
    result.textContent = "添加成功\\nProvider: " + body.provider.id + " (" + body.provider.kind + ")\\nModel Profile: " + body.modelProfile.name + " → " + body.modelProfile.modelName;
    form.reset();
  } catch (error) {
    result.className = "err";
    result.textContent = "请求失败: " + error;
  }
});
</script>
</body>
</html>`);
  }

  private openRunEventStream(request: IncomingMessage, response: ServerResponse, runId: string): void {
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ version: CONTROL_PLANE_VERSION, runId })}\n\n`);
    const unsubscribe = this.controlPlane.subscribe((event) => {
      if (response.writableEnded) {
        unsubscribe();
        return;
      }
      const payload = event.payload;
      if (typeof payload !== "object" || payload === null || (payload as { runId?: unknown }).runId !== runId) {
        return;
      }
      try {
        const serialized = JSON.stringify(redactSensitiveValue(event));
        response.write(`event: run\ndata: ${serialized}\n\n`);
      } catch {
        response.write("event: error\ndata: {\"code\":\"event_serialization_failed\"}\n\n");
      }
    });
    request.once("close", unsubscribe);
    response.once("close", unsubscribe);
  }

  private async listAgentTasks(response: ServerResponse, query: URLSearchParams): Promise<void> {    const filter: AgentTaskFilter = {};
    const status = query.get("status");
    if (status) filter.status = status as AgentTaskRecordStatus;
    const profileId = query.get("profileId");
    if (profileId) filter.profileId = profileId;
    const runId = query.get("runId");
    if (runId) filter.runId = runId;
    const parentTaskId = query.get("parentTaskId");
    if (parentTaskId) filter.parentTaskId = parentTaskId;
    await this.reply(response, await this.controlPlane.handle({
      version: "v1",
      requestId: nextRequestId(),
      type: "list_tasks",
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    }));
  }

  private async reply(response: ServerResponse, result: ControlPlaneResponse): Promise<void> {
    if (!result.ok) {
      writeControlPlaneFailure(response, result);
      return;
    }
    writeJson(response, 200, result.data);
  }
}

function writeControlPlaneFailure(response: ServerResponse, result: ControlPlaneResponse): void {
  if (result.ok) return;
  writeJson(response, statusForError(result.error.code), { error: result.error });
}

function statusForError(code: string): number {
  if (code === "unauthorized") return 401;
  if (code === "invalid_request" || code === "unknown_command" || code === "unsupported_version" || code === "invalid_request_id") {
    return 400;
  }
  if (code.endsWith("_not_found")) return 404;
  if (code.endsWith("_mismatch") || code === "agent_depth_limit") return 422;
  if (code.endsWith("_unavailable")) return 503;
  if (code === "control_plane_error") return 500;
  return 400;
}

function parseUrl(url: string | undefined): { pathname: string; query: URLSearchParams } {
  try {
    const parsed = new URL(url ?? "/", "http://rest-api.local");
    return { pathname: parsed.pathname, query: parsed.searchParams };
  } catch {
    return { pathname: "/", query: new URLSearchParams() };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function requireMethod(request: IncomingMessage, method: string): void {
  if (request.method !== method) {
    throw new RestApiError(405, "Method not allowed");
  }
}

function requireField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RestApiError(422, `${key} is required`);
  }
  return value;
}

function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        request.removeAllListeners("data");
        request.resume();
        reject(new RestApiError(413, "Request body is too large"));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new RestApiError(400, "Request body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new RestApiError(400, "Request body must be valid JSON"));
      }
    });
    request.on("error", () => reject(new RestApiError(400, "Unable to read request body")));
  });
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `rest-${requestCounter}`;
}
