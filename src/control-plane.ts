import { resolve } from "node:path";
import type { AgentEvent, AgentProfile, AgentResult, AgentTask } from "./contracts.js";
import type { AgentTaskFilter, AgentTaskRecord } from "./task-store.js";
import { AgentRetryError, type AgentRunOptions, type PiAgentManager } from "./manager.js";
import type { ProfileRegistry } from "./registry.js";
import type { AgentFactory } from "./factory.js";
import type { ModelAliases } from "./model-runtime.js";
import type { ModelGateway } from "./model-gateway.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentWorkspaceProvider } from "./workspace.js";

export const CONTROL_PLANE_VERSION = "v1" as const;

export type ControlPlaneRequest =
  | ControlPlaneRequestBase<"list_profiles">
  | ControlPlaneRequestBase<"list_tasks"> & { filter?: AgentTaskFilter }
  | ControlPlaneRequestBase<"get_task"> & { agentTaskId: string }
  | ControlPlaneRequestBase<"get_result"> & { agentTaskId: string }
  | ControlPlaneRequestBase<"run_agent"> & { profileId: string; task: AgentTask }
  | ControlPlaneRequestBase<"retry_agent"> & { agentTaskId: string }
  | ControlPlaneRequestBase<"cancel_agent"> & { agentId: string };

interface ControlPlaneRequestBase<T extends string> {
  version: typeof CONTROL_PLANE_VERSION;
  requestId: string;
  type: T;
}

export type ControlPlaneResponse =
  | ControlPlaneSuccess<AgentProfile[]>
  | ControlPlaneSuccess<AgentTaskRecord[]>
  | ControlPlaneSuccess<AgentTaskRecord | null>
  | ControlPlaneSuccess<AgentResult | null>
  | ControlPlaneSuccess<{
    agentId: string;
    agentTaskId: string;
    attempt: number;
    status: "queued" | "running";
    warnings: string[];
  }>
  | ControlPlaneSuccess<{
    agentId: string;
    agentTaskId: string;
    attempt: number;
    status: "queued" | "running";
  }>
  | ControlPlaneSuccess<{ agentId: string; status: "cancel_requested" }>
  | ControlPlaneFailure;

export interface ControlPlaneExecutionDefaults {
  cwd: string;
  agentDir: string;
  modelRuntime?: ModelRuntime;
  modelAliases?: ModelAliases;
  modelGateway?: ModelGateway;
  workspaceProvider?: AgentWorkspaceProvider;
  parentAgentId?: string;
  maxConcurrentChildren?: number;
}

export interface AgentControlPlaneOptions {
  factory?: AgentFactory;
  execution?: ControlPlaneExecutionDefaults;
}

export interface ControlPlaneSuccess<T> {
  version: typeof CONTROL_PLANE_VERSION;
  requestId: string;
  ok: true;
  data: T;
}

export interface ControlPlaneFailure {
  version: typeof CONTROL_PLANE_VERSION;
  requestId: string;
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export class ControlPlaneProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ControlPlaneProtocolError";
    this.code = code;
  }
}

/**
 * Transport-neutral Control Plane. HTTP, WebSocket, and Worker RPC adapters
 * can forward decoded requests here without exposing Pi objects.
 */
export class AgentControlPlane {
  constructor(
    private readonly registry: ProfileRegistry,
    private readonly manager: PiAgentManager,
    private readonly options: AgentControlPlaneOptions = {},
  ) {}

  async handle(input: unknown): Promise<ControlPlaneResponse> {
    const requestId = getRequestId(input);
    try {
      const request = parseRequest(input);
      switch (request.type) {
        case "list_profiles":
          return success(request.requestId, this.registry.list());
        case "list_tasks":
          return success(request.requestId, await this.manager.listTasks(request.filter));
        case "get_task":
          return success(request.requestId, (await this.manager.getTask(request.agentTaskId)) ?? null);
        case "get_result":
          return success(request.requestId, (await this.manager.getResult(request.agentTaskId)) ?? null);
        case "run_agent":
          return this.runAgent(request);
        case "retry_agent":
          return await this.retryAgent(request);
        case "cancel_agent":
          await this.manager.cancel(request.agentId);
          return success(request.requestId, {
            agentId: request.agentId,
            status: "cancel_requested" as const,
          });
      }
    } catch (error) {
      const protocolError = error instanceof ControlPlaneProtocolError
        ? error
        : new ControlPlaneProtocolError("control_plane_error", "Control Plane request failed");
      return failure(requestId, protocolError.code, protocolError.message);
    }
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    return this.manager.subscribe(listener);
  }

  async flush(): Promise<void> {
    await this.manager.flushEvents();
    await this.manager.flushTasks();
  }

  private runAgent(
    request: Extract<ControlPlaneRequest, { type: "run_agent" }>,
  ): ControlPlaneSuccess<{
    agentId: string;
    agentTaskId: string;
    attempt: number;
    status: "queued" | "running";
    warnings: string[];
  }> {
    if (!this.options.factory || !this.options.execution) {
      throw new ControlPlaneProtocolError(
        "task_submission_unavailable",
        "Control Plane task submission is not configured",
      );
    }
    if (resolve(request.task.workspace) !== resolve(this.options.execution.cwd)) {
      throw new ControlPlaneProtocolError(
        "task_workspace_mismatch",
        "Agent task workspace must match the configured Control Plane workspace",
      );
    }
    if (request.task.depth > this.options.factory.maxDepth) {
      throw new ControlPlaneProtocolError(
        "agent_depth_limit",
        `Agent task depth exceeds the maximum of ${this.options.factory.maxDepth}`,
      );
    }

    let profile: AgentProfile;
    try {
      profile = this.registry.get(request.profileId);
    } catch {
      throw new ControlPlaneProtocolError("profile_not_found", "Agent profile was not found");
    }
    const bound = this.options.factory.bindProfile(profile, request.task);
    const execution = this.options.execution;
    const run = this.manager.runBackground(bound.profile, request.task, {
      cwd: execution.cwd,
      agentDir: execution.agentDir,
      ...(execution.modelRuntime ? { modelRuntime: execution.modelRuntime } : {}),
      ...(execution.modelAliases ? { modelAliases: execution.modelAliases } : {}),
      ...(execution.modelGateway ? { modelGateway: execution.modelGateway } : {}),
      ...(execution.workspaceProvider ? { workspaceProvider: execution.workspaceProvider } : {}),
      ...(execution.parentAgentId ? { parentAgentId: execution.parentAgentId } : {}),
      ...(execution.maxConcurrentChildren !== undefined
        ? { maxConcurrentChildren: execution.maxConcurrentChildren }
        : {}),
    } satisfies AgentRunOptions);
    return success(request.requestId, {
      agentId: run.agentId,
      agentTaskId: run.agentTaskId,
      attempt: run.attempt,
      status: run.status,
      warnings: bound.warnings,
    });
  }

  private async retryAgent(
    request: Extract<ControlPlaneRequest, { type: "retry_agent" }>,
  ): Promise<ControlPlaneSuccess<{
    agentId: string;
    agentTaskId: string;
    attempt: number;
    status: "queued" | "running";
  }>> {
    try {
      const run = await this.manager.retry(request.agentTaskId);
      return success(request.requestId, {
        agentId: run.agentId,
        agentTaskId: run.agentTaskId,
        attempt: run.attempt,
        status: run.status,
      });
    } catch (error) {
      if (error instanceof AgentRetryError) {
        throw new ControlPlaneProtocolError(error.code, error.message);
      }
      throw error;
    }
  }
}

function parseRequest(input: unknown): ControlPlaneRequest {
  if (typeof input !== "object" || input === null) {
    throw new ControlPlaneProtocolError("invalid_request", "Control Plane request must be an object");
  }
  const value = input as Record<string, unknown>;
  if (value.version !== CONTROL_PLANE_VERSION) {
    throw new ControlPlaneProtocolError("unsupported_version", "Unsupported Control Plane version");
  }
  if (typeof value.requestId !== "string" || value.requestId.trim().length === 0) {
    throw new ControlPlaneProtocolError("invalid_request_id", "requestId is required");
  }
  if (typeof value.type !== "string") {
    throw new ControlPlaneProtocolError("invalid_request", "Control Plane request type is required");
  }

  switch (value.type) {
    case "list_profiles":
      return value as unknown as ControlPlaneRequest;
    case "list_tasks":
      return value as unknown as ControlPlaneRequest;
    case "get_task":
    case "get_result":
      requireString(value, "agentTaskId");
      return value as unknown as ControlPlaneRequest;
    case "run_agent":
      requireString(value, "profileId");
      requireTask(value.task);
      return value as unknown as ControlPlaneRequest;
    case "retry_agent":
      requireString(value, "agentTaskId");
      return value as unknown as ControlPlaneRequest;
    case "cancel_agent":
      requireString(value, "agentId");
      return value as unknown as ControlPlaneRequest;
    default:
      throw new ControlPlaneProtocolError("unknown_command", `Unknown Control Plane command: ${value.type}`);
  }
}

function requireString(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== "string" || (value[key] as string).trim().length === 0) {
    throw new ControlPlaneProtocolError("invalid_request", `${key} is required`);
  }
}

function requireTask(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlPlaneProtocolError("invalid_request", "task is required");
  }
  const task = value as Record<string, unknown>;
  requireString(task, "id");
  requireString(task, "workspace");
  requireString(task, "task");
  if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.some((item) => typeof item !== "string")) {
    throw new ControlPlaneProtocolError("invalid_request", "task.acceptanceCriteria must be an array of strings");
  }
  if (typeof task.depth !== "number" || !Number.isInteger(task.depth) || task.depth < 0) {
    throw new ControlPlaneProtocolError("invalid_request", "task.depth must be a non-negative integer");
  }
  for (const key of ["files", "writePaths"] as const) {
    if (task[key] !== undefined && (!Array.isArray(task[key]) || task[key].some((item) => typeof item !== "string"))) {
      throw new ControlPlaneProtocolError("invalid_request", `task.${key} must be an array of strings`);
    }
  }
}

function getRequestId(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const requestId = (input as Record<string, unknown>).requestId;
    if (typeof requestId === "string") return requestId;
  }
  return "unknown";
}

function success<T>(requestId: string, data: T): ControlPlaneSuccess<T> {
  return { version: CONTROL_PLANE_VERSION, requestId, ok: true, data } as ControlPlaneSuccess<T>;
}

function failure(requestId: string, code: string, message: string): ControlPlaneFailure {
  return {
    version: CONTROL_PLANE_VERSION,
    requestId,
    ok: false,
    error: { code, message },
  };
}
