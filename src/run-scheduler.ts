/**
 * RunScheduler: Run lifecycle + task DAG scheduling.
 *
 * A Run is created from a natural-language goal, planned into a validated
 * TaskDAG, then executed task-by-task against the PiAgentManager with a
 * configurable parallelism bound. Tasks whose dependency failed or was
 * cancelled are blocked (cancelled) instead of starting. Every state
 * transition is emitted as an AgentEvent (and persisted when an
 * eventStore is injected), so Run state is never only in memory
 * (multi-agent-development-project-plan.md §7 "所有状态转移必须写入事件表").
 */
import { randomUUID } from "node:crypto";
import type { AgentProfile, AgentResult, AgentTask, CreateAgentRequest } from "./contracts.js";
import { AgentFactory } from "./factory.js";
import type { AgentRunOptions, BackgroundAgentRun } from "./manager.js";
import type { AgentEventStore } from "./event-store.js";
import type { ModelGateway } from "./model-gateway.js";
import type { ModelAliases } from "./model-runtime.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PlanPlanner } from "./planner.js";
import type {
  PlanOutcome,
  PlanTask,
  RunResult,
  RunSnapshot,
  RunStatus,
  RunTaskSnapshot,
  RunTaskStatus,
  TaskDAG,
} from "./plan-contracts.js";
import { computeTaskTransitions } from "./dag.js";
import type { ProfileRegistry } from "./registry.js";
import type { AgentEvent } from "./contracts.js";
import type { RunStore } from "./run-store.js";

/** Role names from the DAG mapped onto built-in execution profiles. */
const ROLE_PROFILE_MAP: Record<string, string> = {
  backend: "coder",
  frontend: "coder",
  docs: "coder",
  devops: "coder",
  qa: "tester",
  tester: "tester",
  coder: "coder",
  researcher: "researcher",
  reviewer: "reviewer",
};

export interface RunCreateOptions {
  goal: string;
  workspace: string;
  /** Pi agent directory; defaults to <workspace>/.pi. */
  agentDir?: string;
  /** Maximum concurrently running tasks (default from scheduler options). */
  maxParallel?: number;
  /** Model profile name for the Planner session. */
  plannerModelProfile?: string;
}

/** Host-visible task execution surface used by the RunScheduler. */
export interface RunTaskManager {
  runBackground(
    profile: AgentProfile,
    task: AgentTask,
    options: AgentRunOptions,
  ): Promise<BackgroundAgentRun>;
  cancel(agentId: string): Promise<void>;
}

export interface RunSchedulerOptions {
  planner: PlanPlanner;
  manager: RunTaskManager;
  factory: AgentFactory;
  registry: ProfileRegistry;
  /** Model routing for task Sessions; required to run real Agents. */
  modelRuntime?: ModelRuntime;
  modelAliases?: ModelAliases;
  modelGateway?: ModelGateway;
  maxParallel?: number;
  now?: () => string;
  eventStore?: AgentEventStore;
  /** Persist Run snapshots so terminal Runs survive a host restart. */
  runStore?: RunStore;
}

interface RunTaskState {
  planTask: PlanTask;
  status: RunTaskStatus;
  agentTaskId?: string;
  profileId?: string;
  result?: AgentResult;
  error?: { code: string; message: string };
}

interface RunState {
  runId: string;
  status: RunStatus;
  goal: string;
  workspace: string;
  agentDir: string;
  maxParallel: number;
  dag?: TaskDAG;
  tasks: Map<string, RunTaskState>;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  cancellationRequested: boolean;
  paused: boolean;
  scheduling: boolean;
}

const DEFAULT_MAX_PARALLEL = 4;

export class RunScheduler {
  private readonly runs = new Map<string, RunState>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly waiters = new Map<string, Array<(result: RunResult) => void>>();
  private readonly results = new Map<string, RunResult>();
  private eventSequence = 0;
  private runWriteQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: RunSchedulerOptions) {}

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Create a Run in the "created" state. Call startRun to plan and execute. */
  createRun(request: RunCreateOptions): RunSnapshot {
    if (request.goal.trim().length === 0) {
      throw new Error("run goal must not be empty");
    }
    if (request.workspace.trim().length === 0) {
      throw new Error("run workspace must not be empty");
    }
    const now = this.now();
    const run: RunState = {
      runId: `run_${randomUUID()}`,
      status: "created",
      goal: request.goal,
      workspace: request.workspace,
      agentDir: request.agentDir ?? `${request.workspace}/.pi`,
      maxParallel: request.maxParallel ?? this.options.maxParallel ?? DEFAULT_MAX_PARALLEL,
      tasks: new Map(),
      createdAt: now,
      updatedAt: now,
      cancellationRequested: false,
      paused: false,
      scheduling: false,
    };
    this.runs.set(run.runId, run);
    this.emit(run, "run.created", { runId: run.runId, goal: run.goal });
    this.persist(run);
    return this.snapshot(run);
  }

  /**
   * Load persisted Run snapshots into memory. Terminal Runs are restored
   * as-is; interrupted Runs (created/planning/ready/running) become
   * "failed" with host_restarted because their execution context (Planner
   * session, live Agents) no longer exists. Task-level recovery is handled
   * by FileAgentTaskStore + retry_agent.
   */
  async loadRuns(): Promise<RunSnapshot[]> {
    if (!this.options.runStore) return [];
    await this.runWriteQueue;
    const restored: RunSnapshot[] = [];
    for (const snapshot of await this.options.runStore.list()) {
      const terminal = isTerminal(snapshot.status);
      const status = terminal ? snapshot.status : "failed";
      const state = this.stateFromSnapshot(snapshot, status);
      if (!terminal) {
        state.error = { code: "host_restarted", message: "Host restarted while the Run was in progress" };
      }
      this.runs.set(state.runId, state);
      if (isTerminal(status)) {
        this.results.set(state.runId, resultFromState(state));
      }
      restored.push(this.snapshot(state));
    }
    return restored;
  }

  /** Wait for all pending Run snapshot writes to settle. */
  async flush(): Promise<void> {
    await this.runWriteQueue;
  }

  /** Plan the Run's goal into a TaskDAG and start scheduling its tasks. */
  async startRun(runId: string): Promise<RunSnapshot> {
    const run = this.requireRun(runId);
    if (run.status !== "created") {
      throw new Error(`run ${runId} cannot be started from status ${run.status}`);
    }
    run.status = "planning";
    this.touch(run);
    this.emit(run, "run.planning_started", { runId });

    let outcome: PlanOutcome;
    try {
      outcome = await this.options.planner.plan(run.goal);
    } catch (error) {
      // A throwing Planner must never leave the Run stuck in "planning".
      run.error = {
        code: "planning_failed",
        message: `Planner threw: ${error instanceof Error ? error.message : String(error)}`,
      };
      this.emit(run, "run.planning_failed", {
        runId,
        reason: { code: "agent_failed", message: run.error.message },
      });
      this.finalize(run);
      return this.snapshot(run);
    }
    if (outcome.status === "planning_failed") {
      run.error = {
        code: outcome.reason.code === "invalid_dag" ? "planning_invalid_dag" : "planning_failed",
        message: planFailureMessage(outcome.reason),
      };
      this.emit(run, "run.planning_failed", { runId, reason: outcome.reason });
      this.finalize(run);
      return this.snapshot(run);
    }

    run.dag = outcome.dag;
    for (const planTask of outcome.dag.tasks) {
      run.tasks.set(planTask.id, { planTask, status: "pending" });
    }
    if (run.cancellationRequested) {
      // The Run was cancelled while planning; never schedule the new tasks.
      for (const task of run.tasks.values()) {
        task.status = "cancelled";
        task.error = { code: "run_cancelled", message: "Run was cancelled during planning" };
        this.emit(
          run,
          "task.cancelled",
          { runId, taskId: task.planTask.id, reason: "run_cancelled" },
          task.planTask.id,
        );
      }
      this.finalize(run);
      return this.snapshot(run);
    }
    run.status = "ready";
    this.touch(run);
    this.emit(run, "run.ready", { runId, taskCount: run.tasks.size });
    run.status = "running";
    this.emit(run, "run.started", { runId });
    void this.schedule(run.runId);
    return this.snapshot(run);
  }

  /** Cancel a Run: running tasks are aborted, pending/ready tasks are cancelled. */
  async cancelRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.status)) return;
    run.cancellationRequested = true;
    this.emit(run, "run.cancel_requested", { runId });

    const running = [...run.tasks.values()].filter((task) => task.status === "running");
    for (const task of running) {
      if (task.profileId) {
        try {
          await this.options.manager.cancel(task.profileId);
        } catch {
          // The agent may already be gone; the launchTask result settles it.
        }
      }
    }
    await this.schedule(run.runId);
  }

  /** Pause a Run: no new tasks start; already-running tasks finish. */
  pauseRun(runId: string): RunSnapshot {
    const run = this.requireRun(runId);
    if (isTerminal(run.status)) return this.snapshot(run);
    run.paused = true;
    this.touch(run);
    this.emit(run, "run.paused", { runId });
    return this.snapshot(run);
  }

  /** Resume a paused Run: scheduling continues. */
  resumeRun(runId: string): RunSnapshot {
    const run = this.requireRun(runId);
    if (!run.paused) return this.snapshot(run);
    run.paused = false;
    this.touch(run);
    this.emit(run, "run.resumed", { runId });
    void this.schedule(run.runId);
    return this.snapshot(run);
  }

  /**
   * Retry a failed/cancelled Run: non-succeeded tasks reset to pending and
   * the Run is scheduled again. Succeeded tasks keep their results.
   */
  retryRun(runId: string): RunSnapshot {
    const run = this.requireRun(runId);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new Error(`run ${runId} cannot be retried from status ${run.status}`);
    }
    for (const task of run.tasks.values()) {
      if (task.status === "succeeded") continue;
      task.status = "pending";
      delete task.result;
      delete task.error;
      delete task.agentTaskId;
      delete task.profileId;
    }
    run.status = "running";
    delete run.error;
    run.cancellationRequested = false;
    run.paused = false;
    // Invalidate the cached terminal result so waitForRun observes the retry.
    this.results.delete(run.runId);
    this.touch(run);
    this.emit(run, "run.retried", { runId });
    void this.schedule(run.runId);
    return this.snapshot(run);
  }

  getRun(runId: string): RunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? this.snapshot(run) : undefined;
  }

  listRuns(): RunSnapshot[] {
    return [...this.runs.values()].map((run) => this.snapshot(run));
  }

  /** Resolves when the Run reaches a terminal state, or immediately if it already has. */
  async waitForRun(runId: string): Promise<RunResult> {
    const existing = this.results.get(runId);
    if (existing) return existing;
    return new Promise<RunResult>((resolve) => {
      const list = this.waiters.get(runId) ?? [];
      list.push(resolve);
      this.waiters.set(runId, list);
    });
  }

  private async schedule(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.scheduling || isTerminal(run.status)) return;
    run.scheduling = true;
    try {
      for (;;) {
        if (run.cancellationRequested) {
          for (const task of run.tasks.values()) {
            if (task.status === "pending" || task.status === "ready") {
              task.status = "cancelled";
              task.error = { code: "run_cancelled", message: "Run was cancelled" };
              this.emit(
                run,
                "task.cancelled",
                { runId, taskId: task.planTask.id, reason: "run_cancelled" },
                task.planTask.id,
              );
            }
          }
          if (!hasActiveTasks(run)) {
            this.finalize(run);
          }
          return;
        }

        // Paused: no new tasks start; running tasks finish and re-trigger
        // schedule() from their completion callback.
        if (run.paused && hasActiveTasks(run)) {
          return;
        }

        const statuses = new Map<string, RunTaskStatus>();
        for (const [taskId, task] of run.tasks) statuses.set(taskId, task.status);
        const { readyTaskIds, blockedTaskIds } = computeTaskTransitions(run.dag!, statuses);

        for (const taskId of blockedTaskIds) {
          const task = run.tasks.get(taskId)!;
          task.status = "cancelled";
          task.error = { code: "dependency_failed", message: "A dependency failed or was cancelled" };
          this.emit(run, "task.cancelled", { runId, taskId, reason: "dependency_failed" }, taskId);
        }

        const running = countRunning(run.tasks);
        const slots = Math.max(0, run.maxParallel - running);
        const toStart = readyTaskIds.slice(0, slots);
        for (const taskId of toStart) {
          const task = run.tasks.get(taskId)!;
          task.status = "ready";
          this.emit(run, "task.ready", { runId, taskId }, taskId);
          void this.launchTask(run, taskId);
        }

        if (!hasActiveTasks(run)) {
          this.finalize(run);
          return;
        }
        // Running tasks re-trigger schedule() from their completion callback.
        return;
      }
    } finally {
      run.scheduling = false;
    }
  }

  private async launchTask(run: RunState, taskId: string): Promise<void> {
    const task = run.tasks.get(taskId);
    if (!task) return;
    task.status = "running";
    this.emit(run, "task.running", { runId: run.runId, taskId }, taskId);

    let result: AgentResult;
    try {
      result = await this.runOne(run, task);
    } catch (error) {
      result = {
        agentId: "",
        agentTaskId: "",
        status: "failed",
        changedFiles: [],
        tests: [],
        risks: [],
        error: {
          code: "scheduler_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    task.result = result;
    if (result.status === "completed") {
      task.status = "succeeded";
      this.emit(run, "task.succeeded", { runId: run.runId, taskId, result }, taskId);
    } else if (result.status === "cancelled") {
      task.status = "cancelled";
      task.error = result.error ?? { code: "agent_cancelled", message: "Agent task was cancelled" };
      this.emit(run, "task.cancelled", { runId: run.runId, taskId, result, error: task.error }, taskId);
    } else {
      task.status = "failed";
      task.error = result.error ?? {
        code: `agent_${result.status}`,
        message: `Agent task ended with status ${result.status}`,
      };
      this.emit(run, "task.failed", { runId: run.runId, taskId, result, error: task.error }, taskId);
    }
    await this.schedule(run.runId);
  }

  /** Resolve a role to a task-bound execution profile and run it in the Manager. */
  private async runOne(run: RunState, task: RunTaskState): Promise<AgentResult> {
    const baseProfile = this.resolveRoleProfile(task.planTask);
    if (!baseProfile) {
      return {
        agentId: "",
        agentTaskId: "",
        status: "failed",
        changedFiles: [],
        tests: [],
        risks: [],
        error: {
          code: "unknown_role",
          message: `no Agent Profile for role "${task.planTask.role}"`,
        },
      };
    }

    const agentTask: AgentTask = {
      id: `${run.runId}:${task.planTask.id}`,
      runId: run.runId,
      taskId: task.planTask.id,
      workspace: run.workspace,
      task: task.planTask.title,
      acceptanceCriteria: task.planTask.acceptanceCriteria,
      ...(task.planTask.writePaths.length > 0 ? { writePaths: task.planTask.writePaths } : {}),
      ...(task.planTask.testCommands.length > 0 ? { testCommands: task.planTask.testCommands } : {}),
      depth: 0,
    };

    // A dedicated per-task profile gives every task its own Agent id, so
    // parallel tasks never collide on the same profile in the Manager.
    const created = this.options.factory.createProfile(
      profileToRequest(baseProfile, `Planned task ${task.planTask.id}`),
      agentTask,
    );    let profile: AgentProfile = created.profile;
    if (task.planTask.modelProfile) {
      profile = structuredClone(profile);
      profile.execution.model = task.planTask.modelProfile;
    }
    task.profileId = profile.id;

    const runOptions: AgentRunOptions = {
      cwd: run.workspace,
      agentDir: run.agentDir,
      ...(this.options.modelRuntime ? { modelRuntime: this.options.modelRuntime } : {}),
      ...(this.options.modelAliases ? { modelAliases: this.options.modelAliases } : {}),
      ...(this.options.modelGateway ? { modelGateway: this.options.modelGateway } : {}),
    };
    const background = await this.options.manager.runBackground(profile, agentTask, runOptions);
    task.agentTaskId = background.agentTaskId;
    return background.promise;
  }

  private resolveRoleProfile(planTask: PlanTask): AgentProfile | undefined {
    const direct = this.safeGet(planTask.role);
    if (direct) return direct;
    const mapped = ROLE_PROFILE_MAP[planTask.role];
    if (mapped) return this.safeGet(mapped);
    return undefined;
  }

  private safeGet(nameOrId: string): AgentProfile | undefined {
    try {
      return this.options.registry.get(nameOrId);
    } catch {
      // registry.get throws ProfileNotFoundError for unknown names.
      return undefined;
    }
  }

  private finalize(run: RunState): void {
    if (isTerminal(run.status)) return;
    this.touch(run);

    const failed = run.error !== undefined
      || [...run.tasks.values()].some(
        (task) => task.status === "failed" || task.status === "cancelled",
      );
    let status: RunStatus;
    if (run.cancellationRequested) {
      status = "cancelled";
    } else if (failed) {
      status = "failed";
    } else {
      status = "succeeded";
    }
    run.status = status;

    const result: RunResult = {
      runId: run.runId,
      status,
      goal: run.goal,
      tasks: this.taskSnapshots(run),
      ...(run.error ? { error: run.error } : {}),
    };
    this.results.set(run.runId, result);
    this.emit(run, `run.${status}`, { runId: run.runId });

    const waiters = this.waiters.get(run.runId);
    if (waiters) {
      this.waiters.delete(run.runId);
      for (const resolve of waiters) resolve(result);
    }
  }

  private snapshot(run: RunState): RunSnapshot {
    return {
      runId: run.runId,
      status: run.status,
      goal: run.goal,
      workspace: run.workspace,
      maxParallel: run.maxParallel,
      ...(run.dag ? { dag: run.dag } : {}),
      tasks: this.taskSnapshots(run),
      ...(run.paused ? { paused: true } : {}),
      ...(run.error ? { error: run.error } : {}),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private taskSnapshots(run: RunState): RunTaskSnapshot[] {
    return [...run.tasks.values()].map((task) => ({
      taskId: task.planTask.id,
      title: task.planTask.title,
      role: task.planTask.role,
      status: task.status,
      dependsOn: task.planTask.dependsOn,
      writePaths: task.planTask.writePaths,
      ...(task.planTask.modelProfile ? { modelProfile: task.planTask.modelProfile } : {}),
      ...(task.agentTaskId ? { agentTaskId: task.agentTaskId } : {}),
      ...(task.profileId ? { profileId: task.profileId } : {}),
      ...(task.error ? { error: task.error } : {}),
      ...(task.result ? { result: task.result } : {}),
    }));
  }

  private emit(run: RunState, type: string, payload: unknown, agentTaskId?: string): void {
    const event: AgentEvent = {
      eventId: `${run.runId}:${++this.eventSequence}`,
      agentId: `run:${run.runId}`,
      ...(agentTaskId ? { agentTaskId } : {}),
      type,
      sequence: this.eventSequence,
      timestamp: this.now(),
      payload,
    };
    for (const listener of this.listeners) listener(event);
    if (this.options.eventStore) {
      void this.options.eventStore.append(event);
    }
    this.persist(run);
  }

  /** Serialize Run snapshot writes so they never interleave. */
  private persist(run: RunState): void {
    if (!this.options.runStore) return;
    const snapshot = this.snapshot(run);
    this.runWriteQueue = this.runWriteQueue
      .then(() => this.options.runStore!.save(snapshot))
      .catch(() => {
        // Persistence is best-effort for live progress; the event store
        // remains the source of truth for recovery.
      });
  }

  private stateFromSnapshot(snapshot: RunSnapshot, status: RunStatus): RunState {
    const tasks = new Map<string, RunTaskState>();
    if (snapshot.dag) {
      for (const planTask of snapshot.dag.tasks) {
        const snap = snapshot.tasks.find((task) => task.taskId === planTask.id);
        tasks.set(planTask.id, {
          planTask,
          status: snap?.status ?? "pending",
          ...(snap?.agentTaskId ? { agentTaskId: snap.agentTaskId } : {}),
          ...(snap?.profileId ? { profileId: snap.profileId } : {}),
          ...(snap?.result ? { result: snap.result as AgentResult } : {}),
          ...(snap?.error ? { error: snap.error } : {}),
        });
      }
    }
    return {
      runId: snapshot.runId,
      status,
      goal: snapshot.goal,
      workspace: snapshot.workspace,
      agentDir: snapshot.workspace,
      maxParallel: snapshot.maxParallel,
      ...(snapshot.dag ? { dag: snapshot.dag } : {}),
      tasks,
      ...(snapshot.error ? { error: snapshot.error } : {}),
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      cancellationRequested: false,
      paused: snapshot.paused === true,
      scheduling: false,
    };
  }

  private requireRun(runId: string): RunState {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return run;
  }

  private touch(run: RunState): void {
    run.updatedAt = this.now();
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function profileToRequest(profile: AgentProfile, reason: string): CreateAgentRequest {
  // A unique name per task avoids ProfileConflictError when two parallel
  // tasks map onto the same built-in role profile.
  const uniqueName = `${profile.name}-${randomUUID().slice(0, 8)}`;
  return {
    name: uniqueName,
    description: profile.description,
    responsibilities: profile.identity.responsibilities,
    nonResponsibilities: profile.identity.nonResponsibilities,
    requestedTools: profile.execution.tools,
    readOnly: profile.execution.readOnly,
    ...(profile.execution.writePaths.length > 0 ? { requestedWritePaths: profile.execution.writePaths } : {}),
    requestedModel: profile.execution.model,
    thinkingLevel: profile.execution.thinkingLevel,
    canDelegate: profile.execution.canDelegate,
    persistence: "ephemeral",
    scope: "task",
    reason,
    createdBy: "system",
  };
}

function countRunning(tasks: ReadonlyMap<string, RunTaskState>): number {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.status === "running") count += 1;
  }
  return count;
}

function hasActiveTasks(run: RunState): boolean {
  for (const task of run.tasks.values()) {
    if (task.status === "pending" || task.status === "ready" || task.status === "running") return true;
  }
  return false;
}

function isTerminal(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function resultFromState(run: RunState): RunResult {
  return {
    runId: run.runId,
    status: run.status as RunResult["status"],
    goal: run.goal,
    tasks: [...run.tasks.values()].map((task) => ({
      taskId: task.planTask.id,
      title: task.planTask.title,
      role: task.planTask.role,
      status: task.status,
      dependsOn: task.planTask.dependsOn,
      writePaths: task.planTask.writePaths,
      ...(task.planTask.modelProfile ? { modelProfile: task.planTask.modelProfile } : {}),
      ...(task.agentTaskId ? { agentTaskId: task.agentTaskId } : {}),
      ...(task.profileId ? { profileId: task.profileId } : {}),
      ...(task.error ? { error: task.error } : {}),
      ...(task.result ? { result: task.result } : {}),
    })),
    ...(run.error ? { error: run.error } : {}),
  };
}

function planFailureMessage(reason: { code: string; message?: string; issues?: { message: string }[] }): string {
  if (reason.code === "invalid_dag" && reason.issues) {
    return `Planner produced an invalid DAG: ${reason.issues.map((issue) => issue.message).join("; ")}`;
  }
  return reason.message ?? `Planner failed (${reason.code})`;
}
