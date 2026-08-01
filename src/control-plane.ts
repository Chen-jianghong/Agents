import { resolve } from "node:path";
import type { AgentEvent, AgentProfile, AgentResult, AgentTask } from "./contracts.js";
import type { AgentTaskFilter, AgentTaskRecord } from "./task-store.js";
import type { AgentEventFilter, AgentEventStore } from "./event-store.js";
import { AgentRetryError, type AgentRunOptions, type PiAgentManager } from "./manager.js";
import type { ProfileRegistry } from "./registry.js";
import type { AgentFactory } from "./factory.js";
import type { ModelAliases } from "./model-runtime.js";
import type { ModelGateway } from "./model-gateway.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentWorkspaceProvider } from "./workspace.js";
import type { RunSnapshot } from "./plan-contracts.js";
import type { RunScheduler } from "./run-scheduler.js";

export const CONTROL_PLANE_VERSION = "v1" as const;

export type ControlPlaneRequest =
  | ControlPlaneRequestBase<"list_profiles">
  | ControlPlaneRequestBase<"list_tasks"> & { filter?: AgentTaskFilter }
  | ControlPlaneRequestBase<"get_task"> & { agentTaskId: string }
  | ControlPlaneRequestBase<"get_result"> & { agentTaskId: string }
  | ControlPlaneRequestBase<"run_agent"> & { profileId: string; task: AgentTask }
  | ControlPlaneRequestBase<"register_profile"> & { profile: AgentProfile }
  | ControlPlaneRequestBase<"retry_agent"> & { agentTaskId: string }
  | ControlPlaneRequestBase<"cancel_agent"> & { agentId: string }
  | ControlPlaneRequestBase<"create_run"> & {
    goal: string;
    workspace: string;
    maxParallel?: number;
    plannerModelProfile?: string;
  }
  | ControlPlaneRequestBase<"start_run"> & { runId: string }
  | ControlPlaneRequestBase<"cancel_run"> & { runId: string }
  | ControlPlaneRequestBase<"pause_run"> & { runId: string }
  | ControlPlaneRequestBase<"resume_run"> & { runId: string }
  | ControlPlaneRequestBase<"retry_run"> & { runId: string }
  | ControlPlaneRequestBase<"get_run"> & { runId: string }
  | ControlPlaneRequestBase<"list_runs">
  | ControlPlaneRequestBase<"list_events"> & { filter?: AgentEventFilter & { runId?: string } };

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
  | ControlPlaneSuccess<{ profileId: string; version: number }>
  | ControlPlaneSuccess<{
    agentId: string;
    agentTaskId: string;
    attempt: number;
    status: "queued" | "running";
  }>
  | ControlPlaneSuccess<{ agentId: string; status: "cancel_requested" }>
  | ControlPlaneSuccess<RunSnapshot>
  | ControlPlaneSuccess<RunSnapshot | null>
  | ControlPlaneSuccess<RunSnapshot[]>
  | ControlPlaneSuccess<{ runId: string; status: "cancel_requested" }>
  | ControlPlaneSuccess<AgentEvent[]>
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
  /** Optional RunScheduler exposing Run/DAG commands (create_run / start_run / ...). */
  runScheduler?: RunScheduler;
  /** Optional event store for historical event queries (list_events). */
  eventStore?: AgentEventStore;
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
          return await this.runAgent(request);
        case "register_profile":
          return this.registerProfile(request);
        case "retry_agent":
          return await this.retryAgent(request);
        case "cancel_agent":
          await this.manager.cancel(request.agentId);
          return success(request.requestId, {
            agentId: request.agentId,
            status: "cancel_requested" as const,
          });
        case "create_run":
          return this.createRun(request);
        case "start_run":
          return this.startRun(request);
        case "cancel_run":
          return await this.cancelRun(request);
        case "pause_run":
          return this.pauseRun(request);
        case "resume_run":
          return this.resumeRun(request);
        case "retry_run":
          return this.retryRun(request);
        case "get_run":
          return success(request.requestId, this.getRun(request.runId));
        case "list_runs":
          return success(request.requestId, this.listRuns());
        case "list_events":
          return await this.listEvents(request);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const protocolError = error instanceof ControlPlaneProtocolError
        ? error
        : new ControlPlaneProtocolError("control_plane_error", message);
      return failure(requestId, protocolError.code, protocolError.message);
    }
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    const disposers: Array<() => void> = [this.manager.subscribe(listener)];
    if (this.options.runScheduler) {
      disposers.push(this.options.runScheduler.subscribe(listener));
    }
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  async flush(): Promise<void> {
    await this.manager.flushEvents();
    await this.manager.flushTasks();
    await this.options.runScheduler?.flush();
  }

  private createRun(
    request: Extract<ControlPlaneRequest, { type: "create_run" }>,
  ): ControlPlaneSuccess<RunSnapshot> {
    const scheduler = this.requireRunScheduler("run_submission_unavailable");
    if (!this.options.execution) {
      throw new ControlPlaneProtocolError(
        "run_submission_unavailable",
        "Control Plane Run submission is not configured",
      );
    }
    if (resolve(request.workspace) !== resolve(this.options.execution.cwd)) {
      throw new ControlPlaneProtocolError(
        "run_workspace_mismatch",
        "Run workspace must match the configured Control Plane workspace",
      );
    }
    const snapshot = scheduler.createRun({
      goal: request.goal,
      workspace: request.workspace,
      ...(request.maxParallel !== undefined ? { maxParallel: request.maxParallel } : {}),
      ...(request.plannerModelProfile !== undefined
        ? { plannerModelProfile: request.plannerModelProfile }
        : {}),
    });
    return success(request.requestId, snapshot);
  }

  private startRun(
    request: Extract<ControlPlaneRequest, { type: "start_run" }>,
  ): ControlPlaneSuccess<RunSnapshot> {
    const scheduler = this.requireRunScheduler("run_scheduler_unavailable");
    const run = scheduler.getRun(request.runId);
    if (!run) {
      throw new ControlPlaneProtocolError("run_not_found", `Run ${request.runId} was not found`);
    }
    if (run.status !== "created") {
      // Idempotent: an already-started Run returns its current snapshot.
      return success(request.requestId, run);
    }
    // Planning is asynchronous: the client observes progress through
    // Control Plane events and get_run snapshots.
    void scheduler.startRun(request.runId).catch((error: unknown) => {
      // startRun never rejects after the planner try/catch, but a
      // programming error must not surface as an unhandled rejection.
      scheduler.getRun(request.runId);
      void error;
    });
    return success(request.requestId, scheduler.getRun(request.runId)!);
  }

  private async cancelRun(
    request: Extract<ControlPlaneRequest, { type: "cancel_run" }>,
  ): Promise<ControlPlaneSuccess<{ runId: string; status: "cancel_requested" }>> {
    const scheduler = this.requireRunScheduler("run_scheduler_unavailable");
    const run = scheduler.getRun(request.runId);
    if (!run) {
      throw new ControlPlaneProtocolError("run_not_found", `Run ${request.runId} was not found`);
    }
    await scheduler.cancelRun(request.runId);
    return success(request.requestId, {
      runId: request.runId,
      status: "cancel_requested" as const,
    });
  }

  private getRun(runId: string): RunSnapshot | null {
    const scheduler = this.requireRunScheduler("run_scheduler_unavailable");
    return scheduler.getRun(runId) ?? null;
  }

  private pauseRun(
    request: Extract<ControlPlaneRequest, { type: "pause_run" }>,
  ): ControlPlaneSuccess<RunSnapshot> {
    const scheduler = this.requireRunScheduler("run_scheduler_unavailable");
    return success(request.requestId, scheduler.pauseRun(request.runId));
  }

  private resumeRun(
    request: Extract<ControlPlaneRequest, { type: "resume_run" }>,
  ): ControlPlaneSuccess<RunSnapshot> {
    const scheduler = this.requireRunScheduler("run_scheduler_unavailable");
    return success(request.requestId, scheduler.resumeRun(request.runId));
  }

  private retryRun(
    request: Extract<ControlPlaneRequest, { type: "retry_run" }>,
  ): ControlPlaneSuccess<RunSnapshot> {
    const scheduler = this.requireRunScheduler("run_scheduler_unavailable");
    return success(request.requestId, scheduler.retryRun(request.runId));
  }

  private listRuns(): RunSnapshot[] {
    const scheduler = this.requireRunScheduler("run_scheduler_unavailable");
    return scheduler.listRuns();
  }

  private async listEvents(
    request: Extract<ControlPlaneRequest, { type: "list_events" }>,
  ): Promise<ControlPlaneSuccess<AgentEvent[]>> {
    if (!this.options.eventStore) {
      throw new ControlPlaneProtocolError(
        "event_store_unavailable",
        "Historical event queries are not configured",
      );
    }
    const filter: AgentEventFilter = { ...(request.filter ?? {}) };
    if (request.filter?.runId) {
      // Run events are stored with agentId `run:<runId>`.
      filter.agentId = `run:${request.filter.runId}`;
      delete (filter as { runId?: string }).runId;
    }
    return success(request.requestId, await this.options.eventStore.list(filter));
  }

  private requireRunScheduler(code: string): RunScheduler {
    if (!this.options.runScheduler) {
      throw new ControlPlaneProtocolError(
        code,
        "Control Plane Run scheduling is not configured",
      );
    }
    return this.options.runScheduler;
  }

  private async runAgent(
    request: Extract<ControlPlaneRequest, { type: "run_agent" }>,
  ): Promise<ControlPlaneSuccess<{
    agentId: string;
    agentTaskId: string;
    attempt: number;
    status: "queued" | "running";
    warnings: string[];
  }>> {
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
    const run = await this.manager.runBackground(bound.profile, request.task, {
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

  private registerProfile(
    request: Extract<ControlPlaneRequest, { type: "register_profile" }>,
  ): ControlPlaneSuccess<{ profileId: string; version: number }> {
    const registered = this.registry.register(request.profile);
    return success(request.requestId, {
      profileId: registered.id,
      version: registered.version,
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
    case "register_profile":
      requireProfile(value.profile);
      return value as unknown as ControlPlaneRequest;
    case "retry_agent":
      requireString(value, "agentTaskId");
      return value as unknown as ControlPlaneRequest;
    case "cancel_agent":
      requireString(value, "agentId");
      return value as unknown as ControlPlaneRequest;
    case "create_run":
      requireString(value, "goal");
      requireString(value, "workspace");
      if (
        value.maxParallel !== undefined
        && (typeof value.maxParallel !== "number" || !Number.isInteger(value.maxParallel) || value.maxParallel < 1)
      ) {
        throw new ControlPlaneProtocolError("invalid_request", "maxParallel must be a positive integer");
      }
      if (
        value.plannerModelProfile !== undefined
        && (typeof value.plannerModelProfile !== "string" || value.plannerModelProfile.trim().length === 0)
      ) {
        throw new ControlPlaneProtocolError("invalid_request", "plannerModelProfile must be a non-empty string");
      }
      return value as unknown as ControlPlaneRequest;
    case "start_run":
    case "cancel_run":
    case "pause_run":
    case "resume_run":
    case "retry_run":
    case "get_run":
      requireString(value, "runId");
      return value as unknown as ControlPlaneRequest;
    case "list_runs":
      return value as unknown as ControlPlaneRequest;
    case "list_events":
      if (value.filter !== undefined) {
        if (typeof value.filter !== "object" || value.filter === null || Array.isArray(value.filter)) {
          throw new ControlPlaneProtocolError("invalid_request", "filter must be an object");
        }
        const filter = value.filter as Record<string, unknown>;
        for (const key of ["agentId", "agentTaskId", "type", "runId"] as const) {
          if (filter[key] !== undefined && (typeof filter[key] !== "string" || (filter[key] as string).trim().length === 0)) {
            throw new ControlPlaneProtocolError("invalid_request", `filter.${key} must be a non-empty string`);
          }
        }
      }
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

function requireTask(value: unknown): void {  if (typeof value !== "object" || value === null || Array.isArray(value)) {
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

function requireProfile(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlPlaneProtocolError("invalid_request", "profile is required");
  }
  const profile = value as Record<string, unknown>;
  requireString(profile, "id");
  requireString(profile, "name");
  if (typeof profile.version !== "number" || !Number.isSafeInteger(profile.version) || profile.version < 1) {
    throw new ControlPlaneProtocolError("invalid_request", "profile.version must be a positive integer");
  }
  if (typeof profile.identity !== "object" || profile.identity === null) {
    throw new ControlPlaneProtocolError("invalid_request", "profile.identity is required");
  }
  if (typeof profile.execution !== "object" || profile.execution === null) {
    throw new ControlPlaneProtocolError("invalid_request", "profile.execution is required");
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
