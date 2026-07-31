import type { Model } from "@earendil-works/pi-ai/compat";
import type {
  AgentEvent,
  AgentProfile,
  AgentResult,
  AgentTask,
} from "./contracts.js";
import type { ManagedAgent, PiSessionFactoryOptions } from "./pi-adapter.js";
import type { ModelAliases } from "./model-runtime.js";
import type { ModelGateway } from "./model-gateway.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentWorkspaceLease, AgentWorkspaceProvider } from "./workspace.js";
import type { AgentEventStore } from "./event-store.js";
import { AgentEventPersistenceError } from "./event-store.js";
import type {
  AgentTaskRecord,
  AgentTaskExecutionSnapshot,
  AgentTaskFilter,
  AgentTaskRecordStatus,
  AgentTaskStore,
} from "./task-store.js";
import { AgentTaskPersistenceError } from "./task-store.js";
import { validateProfile } from "./profile-validator.js";

export interface AgentRunOptions {
  cwd: string;
  agentDir: string;
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  modelAliases?: ModelAliases;
  modelGateway?: ModelGateway;
  workspaceProvider?: AgentWorkspaceProvider;
  parentAgentId?: string;
  maxConcurrentChildren?: number;
}

export interface BackgroundAgentRun {
  agentTaskId: string;
  agentId: string;
  attempt: number;
  status: "queued" | "running";
  promise: Promise<AgentResult>;
}

export interface AgentTaskRecoveryContext {
  readonly record: AgentTaskRecord;
  readonly profile: AgentProfile;
  readonly task: AgentTask;
}

export interface AgentTaskRecovery {
  /**
   * Re-inject host-owned runtime dependencies for a persisted task. The
   * resolver must provide cwd and agentDir; model runtimes, gateways and
   * workspace providers must never be loaded from task JSON.
   */
  resolveExecution(
    context: AgentTaskRecoveryContext,
  ): AgentRunOptions | Promise<AgentRunOptions>;
}

export interface AgentManagerOptions {
  maxConcurrentTasks?: number;
  taskRecovery?: AgentTaskRecovery;
}

export class AgentRetryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentRetryError";
    this.code = code;
  }
}

export interface AgentSessionFactory {
  create(
    profile: AgentProfile,
    task: AgentTask,
    options: PiSessionFactoryOptions,
  ): Promise<ManagedAgent>;
}

export class PiAgentManager {
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly results = new Map<string, AgentResult>();
  private readonly runs = new Map<string, Promise<AgentResult>>();
  private readonly activeTasks = new Set<string>();
  private readonly activeChildren = new Map<string, number>();
  private readonly eventListeners = new Set<(event: AgentEvent) => void>();
  private eventSequence = 0;

  private eventWriteQueue: Promise<void> = Promise.resolve();
  private eventPersistenceError: unknown;
  private taskWriteQueue: Promise<void> = Promise.resolve();
  private taskPersistenceError: unknown;
  private readonly taskCreatedAt = new Map<string, string>();
  private readonly taskAttempts = new Map<string, number>();
  private readonly executions = new Map<string, AgentExecution>();
  private readonly reservingTasks = new Set<string>();
  private readonly pendingReservations = new Set<Promise<void>>();
  private readonly pendingRuns = new Map<string, PendingRun>();
  private readonly cancelRequestedTasks = new Set<string>();
  private readonly taskRecovery: AgentTaskRecovery | undefined;
  private readonly maxConcurrentTasks: number | undefined;
  private activeTaskSlots = 0;
  private readonly queuedTasks = new Map<string, QueuedTask>();
  private readonly taskQueue: QueuedTask[] = [];

  constructor(
    private readonly sessionFactory: AgentSessionFactory,
    private readonly eventStore?: AgentEventStore,
    private readonly taskStore?: AgentTaskStore,
    options: AgentManagerOptions = {},
  ) {
    if (options.maxConcurrentTasks !== undefined) {
      assertPositiveInteger(options.maxConcurrentTasks, "maxConcurrentTasks");
    }
    this.taskRecovery = options.taskRecovery;
    this.maxConcurrentTasks = options.maxConcurrentTasks;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async flushEvents(): Promise<void> {
    await this.eventWriteQueue;
    if (this.eventPersistenceError !== undefined) {
      throw new AgentEventPersistenceError("Agent event persistence failed");
    }
  }

  async flushTasks(): Promise<void> {
    // A reservation may still be reading the store before it enqueues its
    // queued/starting snapshot. Wait for both phases, including writes that
    // are appended while the first phase is settling.
    while (this.pendingReservations.size > 0) {
      await Promise.all([
        this.taskWriteQueue,
        ...this.pendingReservations,
      ]);
    }
    await this.taskWriteQueue;
    if (this.taskPersistenceError !== undefined) {
      throw new AgentTaskPersistenceError("Agent task persistence failed");
    }
  }

  async run(
    profile: AgentProfile,
    task: AgentTask,
    options: AgentRunOptions,
  ): Promise<AgentResult> {
    return this.runInternal(profile, task, options, false);
  }

  private async runInternal(
    profile: AgentProfile,
    task: AgentTask,
    options: AgentRunOptions,
    allowPersistedRecovery: boolean,
  ): Promise<AgentResult> {
    const pending: PendingRun = { profile, task, options };
    this.pendingRuns.set(task.id, pending);
    let settleReservation!: () => void;
    const reservationSettled = new Promise<void>((resolve) => {
      settleReservation = resolve;
    });
    this.pendingReservations.add(reservationSettled);
    let reservation: Awaited<ReturnType<PiAgentManager["reserve"]>>;
    try {
      reservation = await this.reserve(task.id, options, allowPersistedRecovery);
    } finally {
      if (this.pendingRuns.get(task.id) === pending) this.pendingRuns.delete(task.id);
      this.pendingReservations.delete(reservationSettled);
      settleReservation();
    }
    if (!reservation.allowed) {
      this.cancelRequestedTasks.delete(task.id);
      const result = failureResult(profile, task, reservation.code, reservation.message);
      if (reservation.code !== "agent_task_already_running" && reservation.code !== "agent_task_already_completed") {
        this.results.set(task.id, result);
        this.enqueueTaskRecord(profile, task, "failed", { result }, options);
        await this.taskWriteQueue;
      }
      return result;
    }

    if (this.cancelRequestedTasks.delete(task.id)) {
      const result = failureResult(
        profile,
        task,
        "agent_cancelled",
        "Agent execution was cancelled before it started",
        "cancelled",
      );
      this.results.set(task.id, result);
      this.enqueueTaskRecord(profile, task, "cancelled", {
        result,
        finishedAt: new Date().toISOString(),
      }, options);
      await this.taskWriteQueue;
      this.release(task.id, options);
      return result;
    }

    const attempt = (this.taskAttempts.get(task.id) ?? 0) + 1;
    this.taskAttempts.set(task.id, attempt);
    this.executions.set(task.id, {
      profile: structuredClone(profile),
      task: structuredClone(task),
      options,
    });

    const slotAcquired = await this.acquireTaskSlot(profile, task);
    if (!slotAcquired) {
      const result = this.results.get(task.id) ?? failureResult(
        profile,
        task,
        "agent_cancelled",
        "Agent execution was cancelled before it started",
        "cancelled",
      );
      this.release(task.id, options);
      return structuredClone(result);
    }

    let workspaceLease: AgentWorkspaceLease | undefined;
    try {
      this.enqueueTaskRecord(profile, task, "starting", {}, options);
      let managedAgent: ManagedAgent;
      try {
        workspaceLease = options.workspaceProvider
          ? await options.workspaceProvider.acquire(profile, task, {
            cwd: options.cwd,
            agentDir: options.agentDir,
          })
          : undefined;
        managedAgent = await this.createAgent(profile, task, options, workspaceLease);
      } catch (error) {
        const result = failureResult(
          profile,
          task,
          workspaceLease ? "agent_session_create_failed" : "agent_workspace_acquire_failed",
          error instanceof Error ? error.message : String(error),
        );
        this.results.set(task.id, result);
        this.enqueueTaskRecord(profile, task, "failed", { result, finishedAt: new Date().toISOString() }, options);
        await this.taskWriteQueue;
        return result;
      }
      this.agents.set(task.id, managedAgent);
      this.enqueueTaskRecord(profile, task, "running", {
        sessionId: managedAgent.sessionId,
        startedAt: new Date().toISOString(),
      }, options);
      await this.emitLifecycleEvent(managedAgent, task, "agent_manager_started", {
        profileVersion: profile.version,
        attempt,
      });
      const unsubscribe = managedAgent.subscribe((event) => this.dispatchEvent(event));
      try {
        let result: AgentResult;
        try {
          result = await managedAgent.prompt(task);
        } catch (error) {
          result = failureResult(
            profile,
            task,
            "agent_execution_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        try {
          await this.flushEvents();
        } catch (error) {
          result = failureResult(
            profile,
            task,
            "agent_event_persistence_failed",
            error instanceof Error ? error.message : "Agent event persistence failed",
          );
        }
        this.results.set(task.id, result);
        this.enqueueTaskRecord(profile, task, toTaskStatus(result.status), {
          sessionId: managedAgent.sessionId,
          result,
          finishedAt: new Date().toISOString(),
        }, options);
        await this.taskWriteQueue;
        await this.emitLifecycleEvent(managedAgent, task, `agent_manager_${result.status}`, {
          status: result.status,
          attempt,
        });
        return result;
      } finally {
        unsubscribe();
      }
    } finally {
      await this.releaseWorkspace(profile, task, options.workspaceProvider, workspaceLease);
      this.release(task.id, options);
      this.releaseTaskSlot();
    }
  }

  runBackground(
    profile: AgentProfile,
    task: AgentTask,
    options: AgentRunOptions,
  ): BackgroundAgentRun {
    return this.startBackground(profile, task, options, false);
  }

  private startBackground(
    profile: AgentProfile,
    task: AgentTask,
    options: AgentRunOptions,
    allowPersistedRecovery: boolean,
    reportedAttempt?: number,
  ): BackgroundAgentRun {
    const promise = this.runInternal(profile, task, options, allowPersistedRecovery);
    this.runs.set(task.id, promise);
    void promise.then(
      () => {
        if (this.runs.get(task.id) === promise) this.runs.delete(task.id);
      },
      () => {
        if (this.runs.get(task.id) === promise) this.runs.delete(task.id);
      },
    );
    return {
      agentTaskId: task.id,
      agentId: profile.id,
      attempt: reportedAttempt ?? this.taskAttempts.get(task.id) ?? 1,
      status: this.queuedTasks.has(task.id)
        || (this.reservingTasks.has(task.id)
          && this.maxConcurrentTasks !== undefined
          && this.activeTaskSlots >= this.maxConcurrentTasks)
        ? "queued"
        : "running",
      promise,
    };
  }

  async retry(agentTaskId: string): Promise<BackgroundAgentRun> {
    const execution = this.executions.get(agentTaskId);
    if (this.activeTasks.has(agentTaskId) || this.reservingTasks.has(agentTaskId)) {
      throw new AgentRetryError(
        "agent_task_already_running",
        `Agent task ${agentTaskId} is still running`,
      );
    }

    const record = await this.taskStore?.get(agentTaskId);
    const persistedResult = record?.result;
    const result = this.results.get(agentTaskId) ?? persistedResult;
    if (record?.status === "completed" || persistedResult?.status === "completed" || result?.status === "completed") {
      throw new AgentRetryError(
        "agent_task_already_completed",
        `Completed Agent task ${agentTaskId} cannot be retried`,
      );
    }

    const retryable = result?.status === "failed"
      || result?.status === "cancelled"
      || result?.status === "timed_out"
      || record?.status === "failed"
      || record?.status === "cancelled"
      || record?.status === "timed_out"
      // A task left in an active state by a dead Manager is recoverable only
      // through this explicit retry path. A live local execution was rejected
      // above, so these records are orphan snapshots from this Manager's view.
      || record?.status === "queued"
      || record?.status === "starting"
      || record?.status === "running";
    if (!retryable) {
      throw new AgentRetryError(
        "agent_retry_unavailable",
        `Agent task ${agentTaskId} has no recoverable attempt`,
      );
    }

    const profile = this.resolveRetryProfile(agentTaskId, record, execution);
    const task = record?.task ?? execution?.task;
    if (!task) {
      throw new AgentRetryError(
        "agent_retry_unavailable",
        `Agent task ${agentTaskId} has no persisted task snapshot`,
      );
    }
    if (task.id !== agentTaskId) {
      throw new AgentRetryError(
        "agent_retry_snapshot_invalid",
        `Persisted Agent task ${agentTaskId} has a mismatched task snapshot`,
      );
    }

    let retryOptions = execution?.options;
    if (!retryOptions) {
      if (!record) {
        throw new AgentRetryError(
          "agent_retry_unavailable",
          `Agent task ${agentTaskId} has no persisted execution snapshot`,
        );
      }
      retryOptions = await this.resolveRetryExecution(record, profile, task);
    }

    if (record?.attempt !== undefined) {
      if (!Number.isSafeInteger(record.attempt) || record.attempt < 1) {
        throw new AgentRetryError(
          "agent_retry_snapshot_invalid",
          `Persisted Agent task ${agentTaskId} has an invalid attempt number`,
        );
      }
      this.taskAttempts.set(
        agentTaskId,
        Math.max(this.taskAttempts.get(agentTaskId) ?? 0, record.attempt),
      );
    }
    if (record?.createdAt) this.taskCreatedAt.set(agentTaskId, record.createdAt);

    // Remove only the in-memory result for the attempt being replaced. The
    // durable record is overwritten by runInternal after it claims the retry.
    this.results.delete(agentTaskId);
    const nextAttempt = (record?.attempt ?? this.taskAttempts.get(agentTaskId) ?? 0) + 1;
    return this.startBackground(profile, task, retryOptions, true, nextAttempt);
  }

  private resolveRetryProfile(
    agentTaskId: string,
    record: AgentTaskRecord | undefined,
    execution: AgentExecution | undefined,
  ): AgentProfile {
    const snapshot = record?.profileSnapshot ?? execution?.profile;
    if (!snapshot) {
      throw new AgentRetryError(
        "agent_retry_unavailable",
        `Agent task ${agentTaskId} has no persisted Profile snapshot`,
      );
    }
    try {
      validateProfile(snapshot);
    } catch {
      throw new AgentRetryError(
        "agent_retry_snapshot_invalid",
        `Persisted Profile snapshot for Agent task ${agentTaskId} is invalid`,
      );
    }
    if (record && (snapshot.id !== record.profileId || snapshot.version !== record.profileVersion)) {
      throw new AgentRetryError(
        "agent_retry_snapshot_invalid",
        `Persisted Profile snapshot for Agent task ${agentTaskId} does not match its record`,
      );
    }
    return structuredClone(snapshot);
  }

  private async resolveRetryExecution(
    record: AgentTaskRecord,
    profile: AgentProfile,
    task: AgentTask,
  ): Promise<AgentRunOptions> {
    let resolved: AgentRunOptions;
    if (this.taskRecovery) {
      try {
        resolved = await this.taskRecovery.resolveExecution({
          record: structuredClone(record),
          profile: structuredClone(profile),
          task: structuredClone(task),
        });
      } catch (error) {
        if (error instanceof AgentRetryError) throw error;
        throw new AgentRetryError(
          "agent_retry_execution_unavailable",
          `Host could not restore execution for Agent task ${task.id}`,
        );
      }
    } else {
      throw new AgentRetryError(
        "agent_retry_execution_unavailable",
        `Host execution recovery is required for Agent task ${task.id}`,
      );
    }

    validateRunOptions(resolved, task.id);
    if (record.executionSnapshot) {
      assertMatchingExecutionSnapshot(task.id, record.executionSnapshot, resolved);
    }
    return resolved;
  }

  async getResult(agentTaskId: string): Promise<AgentResult | undefined> {
    const result = this.results.get(agentTaskId);
    if (result) return structuredClone(result);
    const pending = this.runs.get(agentTaskId);
    if (pending) return structuredClone(await pending);
    const persisted = await this.taskStore?.get(agentTaskId);
    if (persisted?.result) return structuredClone(persisted.result);
    return undefined;
  }

  async getTask(agentTaskId: string): Promise<AgentTaskRecord | undefined> {
    return this.taskStore?.get(agentTaskId);
  }

  async listTasks(filter?: AgentTaskFilter): Promise<AgentTaskRecord[]> {
    return this.taskStore ? this.taskStore.list(filter) : [];
  }

  async cancel(agentId: string): Promise<void> {
    await this.cancelQueuedTasks(agentId);
    const agents = [...this.agents.values()].filter((agent) => agent.agentId === agentId);
    await Promise.all(agents.map((agent) => agent.cancel()));
  }

  getAgent(agentId: string): ManagedAgent | undefined {
    return [...this.agents.values()].find((agent) => agent.agentId === agentId);
  }

  private async createAgent(
    profile: AgentProfile,
    task: AgentTask,
    options: AgentRunOptions,
    workspaceLease?: AgentWorkspaceLease,
  ): Promise<ManagedAgent> {
    const agent = await this.sessionFactory.create(profile, task, {
      cwd: workspaceLease?.cwd ?? options.cwd,
      agentDir: workspaceLease?.agentDir ?? options.agentDir,
      ...(options.model ? { model: options.model } : {}),
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      ...(options.modelAliases ? { modelAliases: options.modelAliases } : {}),
      ...(options.modelGateway ? { modelGateway: options.modelGateway } : {}),
    });
    return agent;
  }

  private async releaseWorkspace(
    profile: AgentProfile,
    task: AgentTask,
    provider: AgentWorkspaceProvider | undefined,
    workspaceLease: AgentWorkspaceLease | undefined,
  ): Promise<void> {
    if (!provider || !workspaceLease) return;
    try {
      await workspaceLease.release();
    } catch (error) {
      this.dispatchEvent({
        eventId: `manager:${task.id}:${this.eventSequence + 1}`,
        agentId: profile.id,
        agentTaskId: task.id,
        type: "agent_workspace_release_failed",
        sequence: ++this.eventSequence,
        timestamp: new Date().toISOString(),
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private acquireTaskSlot(profile: AgentProfile, task: AgentTask): Promise<boolean> {
    if (this.maxConcurrentTasks === undefined || this.activeTaskSlots < this.maxConcurrentTasks) {
      this.activeTaskSlots += 1;
      return Promise.resolve(true);
    }

    const queued = new Promise<boolean>((resolve) => {
      const entry: QueuedTask = { profile, task, resolve };
      this.queuedTasks.set(task.id, entry);
      this.taskQueue.push(entry);
    });
    this.enqueueTaskRecord(profile, task, "queued");
    void this.emitTaskLifecycleEvent(profile, task, "agent_manager_queued", {
      queueDepth: this.taskQueue.length,
      attempt: this.taskAttempts.get(task.id) ?? 1,
    });
    return queued;
  }

  private releaseTaskSlot(): void {
    if (this.activeTaskSlots > 0) this.activeTaskSlots -= 1;
    this.pumpTaskQueue();
  }

  private pumpTaskQueue(): void {
    while (
      this.taskQueue.length > 0
      && (this.maxConcurrentTasks === undefined || this.activeTaskSlots < this.maxConcurrentTasks)
    ) {
      const entry = this.taskQueue.shift()!;
      if (!this.queuedTasks.delete(entry.task.id)) continue;
      this.activeTaskSlots += 1;
      entry.resolve(true);
    }
  }

  private async cancelQueuedTasks(agentId: string): Promise<void> {
    const cancellations: Promise<void>[] = [];
    for (const entry of [...this.queuedTasks.values()]) {
      if (entry.profile.id !== agentId) continue;
      this.queuedTasks.delete(entry.task.id);
      const result = failureResult(
        entry.profile,
        entry.task,
        "agent_cancelled",
        "Agent execution was cancelled before it started",
        "cancelled",
      );
      this.results.set(entry.task.id, result);
      this.enqueueTaskRecord(entry.profile, entry.task, "cancelled", {
        result,
        finishedAt: new Date().toISOString(),
      });
      cancellations.push(this.emitTaskLifecycleEvent(entry.profile, entry.task, "agent_manager_cancelled", {
        status: "cancelled",
        queued: true,
      }));
      entry.resolve(false);
    }
    for (const [taskId, pending] of this.pendingRuns) {
      if (pending.profile.id !== agentId || this.activeTasks.has(taskId)) continue;
      this.cancelRequestedTasks.add(taskId);
    }
    await Promise.all(cancellations);
    // The task promise may resolve before the serialized persistence write;
    // cancellation callers should observe the durable cancelled snapshot too.
    await this.taskWriteQueue;
  }

  private async reserve(taskId: string, options: AgentRunOptions, allowPersistedRecovery: boolean): Promise<
    | { allowed: true }
    | { allowed: false; code: string; message: string }
  > {
    const previous = this.results.get(taskId);
    if (previous?.status === "completed") {
      return {
        allowed: false,
        code: "agent_task_already_completed",
        message: `Completed Agent task ${taskId} cannot be run again`,
      };
    }
    if (this.activeTasks.has(taskId)) {
      return {
        allowed: false,
        code: "agent_task_already_running",
        message: `Agent task ${taskId} is already running`,
      };
    }

    if (this.reservingTasks.has(taskId)) {
      return {
        allowed: false,
        code: "agent_task_already_running",
        message: `Agent task ${taskId} is already being claimed`,
      };
    }

    this.reservingTasks.add(taskId);
    try {
      const persisted = await this.taskStore?.get(taskId);
      if (persisted?.status === "completed" || persisted?.result?.status === "completed") {
        return {
          allowed: false,
          code: "agent_task_already_completed",
          message: `Completed Agent task ${taskId} cannot be run again`,
        };
      }
      if (
        !allowPersistedRecovery
        && (persisted?.status === "queued"
          || persisted?.status === "starting"
          || persisted?.status === "running")
      ) {
        return {
          allowed: false,
          code: "agent_task_already_running",
          message: `Agent task ${taskId} has an active persisted attempt`,
        };
      }
      if (persisted) {
        if (Number.isSafeInteger(persisted.attempt) && persisted.attempt > 0) {
          this.taskAttempts.set(
            taskId,
            Math.max(this.taskAttempts.get(taskId) ?? 0, persisted.attempt),
          );
        }
        this.taskCreatedAt.set(taskId, persisted.createdAt);
      }

      if (options.parentAgentId && options.maxConcurrentChildren !== undefined) {
        const active = this.activeChildren.get(options.parentAgentId) ?? 0;
        if (active >= options.maxConcurrentChildren) {
          return {
            allowed: false,
            code: "agent_concurrency_limit",
            message: `Parent Agent ${options.parentAgentId} already has ${active} active child task(s)`,
          };
        }
        this.activeChildren.set(options.parentAgentId, active + 1);
      }
      this.activeTasks.add(taskId);
      return { allowed: true };
    } finally {
      this.reservingTasks.delete(taskId);
    }
  }

  private release(taskId: string, options: AgentRunOptions): void {
    this.activeTasks.delete(taskId);
    if (!options.parentAgentId || options.maxConcurrentChildren === undefined) return;
    const active = this.activeChildren.get(options.parentAgentId) ?? 0;
    if (active <= 1) {
      this.activeChildren.delete(options.parentAgentId);
    } else {
      this.activeChildren.set(options.parentAgentId, active - 1);
    }
  }

  private emitLifecycleEvent(
    agent: ManagedAgent,
    task: AgentTask,
    type: string,
    payload: unknown,
  ): Promise<void> {
    const event: AgentEvent = {
      eventId: `manager:${task.id}:${this.eventSequence + 1}`,
      agentId: agent.agentId,
      agentTaskId: task.id,
      sessionId: agent.sessionId,
      type,
      sequence: ++this.eventSequence,
      timestamp: new Date().toISOString(),
      payload,
    };
    this.dispatchEvent(event);
    return this.eventWriteQueue;
  }

  private emitTaskLifecycleEvent(
    profile: AgentProfile,
    task: AgentTask,
    type: string,
    payload: unknown,
  ): Promise<void> {
    const event: AgentEvent = {
      eventId: `manager:${task.id}:${this.eventSequence + 1}`,
      agentId: profile.id,
      agentTaskId: task.id,
      type,
      sequence: ++this.eventSequence,
      timestamp: new Date().toISOString(),
      payload,
    };
    this.dispatchEvent(event);
    return this.eventWriteQueue;
  }

  private dispatchEvent(event: AgentEvent): void {
    for (const listener of this.eventListeners) listener(event);
    if (!this.eventStore) return;
    this.eventWriteQueue = this.eventWriteQueue.then(async () => {
      try {
        await this.eventStore!.append(event);
      } catch (error) {
        this.eventPersistenceError ??= error;
      }
    });
  }

  private enqueueTaskRecord(
    profile: AgentProfile,
    task: AgentTask,
    status: AgentTaskRecordStatus,
    details: {
      sessionId?: string;
      startedAt?: string;
      finishedAt?: string;
      result?: AgentResult;
    } = {},
    executionOptions?: AgentRunOptions,
  ): void {
    if (!this.taskStore) return;
    const createdAt = this.taskCreatedAt.get(task.id) ?? new Date().toISOString();
    this.taskCreatedAt.set(task.id, createdAt);
    const resolvedExecutionOptions = executionOptions ?? this.executions.get(task.id)?.options;
    const record: AgentTaskRecord = {
      task: structuredClone(task),
      profileId: profile.id,
      profileVersion: profile.version,
      profileSnapshot: structuredClone(profile),
      ...(resolvedExecutionOptions
        ? { executionSnapshot: toExecutionSnapshot(resolvedExecutionOptions) }
        : {}),
      status,
      attempt: this.taskAttempts.get(task.id) ?? 1,
      ...(details.sessionId ? { sessionId: details.sessionId } : {}),
      createdAt,
      ...(details.startedAt ? { startedAt: details.startedAt } : {}),
      ...(details.finishedAt ? { finishedAt: details.finishedAt } : {}),
      ...(details.result ? { result: structuredClone(details.result) } : {}),
    };
    this.taskWriteQueue = this.taskWriteQueue.then(async () => {
      try {
        await this.taskStore!.upsert(record);
      } catch (error) {
        this.taskPersistenceError ??= error;
      }
    });
  }
}

function toTaskStatus(status: AgentResult["status"]): AgentTaskRecordStatus {
  return status;
}

function failureResult(
  profile: AgentProfile,
  task: AgentTask,
  code: string,
  message: string,
  status: AgentResult["status"] = "failed",
): AgentResult {
  return {
    agentId: profile.id,
    agentTaskId: task.id,
    status,
    changedFiles: [],
    tests: [],
    risks: [],
    error: { code, message },
  };
}

interface QueuedTask {
  profile: AgentProfile;
  task: AgentTask;
  resolve: (started: boolean) => void;
}

interface AgentExecution {
  profile: AgentProfile;
  task: AgentTask;
  options: AgentRunOptions;
}

interface PendingRun {
  profile: AgentProfile;
  task: AgentTask;
  options: AgentRunOptions;
}

function toExecutionSnapshot(options: AgentRunOptions | undefined): AgentTaskExecutionSnapshot {
  if (!options) {
    throw new Error("Agent execution options are required before persisting a task");
  }
  return {
    cwd: options.cwd,
    agentDir: options.agentDir,
    ...(options.parentAgentId !== undefined ? { parentAgentId: options.parentAgentId } : {}),
    ...(options.maxConcurrentChildren !== undefined
      ? { maxConcurrentChildren: options.maxConcurrentChildren }
      : {}),
    ...(options.workspaceProvider ? { workspaceProviderRequired: true } : {}),
  };
}

function validateRunOptions(options: AgentRunOptions, taskId: string): void {
  if (typeof options.cwd !== "string" || options.cwd.trim().length === 0
    || typeof options.agentDir !== "string" || options.agentDir.trim().length === 0) {
    throw new AgentRetryError(
      "agent_retry_execution_invalid",
      `Host execution options for Agent task ${taskId} must include cwd and agentDir`,
    );
  }
}

function assertMatchingExecutionSnapshot(
  taskId: string,
  snapshot: AgentTaskExecutionSnapshot,
  options: AgentRunOptions,
): void {
  if (snapshot.cwd !== options.cwd || snapshot.agentDir !== options.agentDir) {
    throw new AgentRetryError(
      "agent_retry_execution_mismatch",
      `Host execution paths do not match the persisted execution for Agent task ${taskId}`,
    );
  }
  if (snapshot.parentAgentId !== options.parentAgentId
    || snapshot.maxConcurrentChildren !== options.maxConcurrentChildren) {
    throw new AgentRetryError(
      "agent_retry_execution_mismatch",
      `Host parent limits do not match the persisted execution for Agent task ${taskId}`,
    );
  }
  if (snapshot.workspaceProviderRequired && !options.workspaceProvider) {
    throw new AgentRetryError(
      "agent_retry_execution_unavailable",
      `A workspace provider is required to recover Agent task ${taskId}`,
    );
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
