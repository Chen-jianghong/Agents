/**
 * WorkerRunTaskManager: RunTaskManager implementation that executes tasks in
 * an independent Worker process through the Control Plane JSONL RPC.
 *
 * Flow per task: register_profile (upload the profile snapshot) ->
 * run_agent (submit) -> poll get_result until a terminal status. This is the
 * host side of "Control Plane -> Worker Manager -> independent Node process
 * -> Pi Agent Core" (multi-agent-development-project-plan.md §10).
 */
import { randomUUID } from "node:crypto";
import type { AgentProfile, AgentResult, AgentTask } from "./contracts.js";
import type { AgentRunOptions, BackgroundAgentRun } from "./manager.js";
import type { RunTaskManager } from "./run-scheduler.js";
import type { ControlPlaneWorkerProcess } from "./worker-process.js";
import {
  CONTROL_PLANE_VERSION,
  type ControlPlaneRequest,
  type ControlPlaneResponse,
} from "./control-plane.js";

export class WorkerRunError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkerRunError";
    this.code = code;
  }
}

export interface WorkerRunTaskManagerOptions {
  worker: ControlPlaneWorkerProcess;
  pollIntervalMs?: number;
  resultTimeoutMs?: number;
}

const TERMINAL_RESULT_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

export class WorkerRunTaskManager implements RunTaskManager {
  private readonly worker: ControlPlaneWorkerProcess;
  private readonly pollIntervalMs: number;
  private readonly resultTimeoutMs: number;

  constructor(options: WorkerRunTaskManagerOptions) {
    this.worker = options.worker;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.resultTimeoutMs = options.resultTimeoutMs ?? 5 * 60_000;
  }

  async runBackground(
    profile: AgentProfile,
    task: AgentTask,
    _options: AgentRunOptions,
  ): Promise<BackgroundAgentRun> {
    // 1. Upload the profile snapshot so the Worker can resolve it.
    const registered = await this.request({ type: "register_profile", profile });
    if (!registered.ok) {
      throw new WorkerRunError(registered.error.code, registered.error.message);
    }

    // 2. Submit the task in the Worker's own Manager.
    const submitted = await this.request({
      type: "run_agent",
      profileId: profile.id,
      task,
    });
    if (!submitted.ok) {
      throw new WorkerRunError(submitted.error.code, submitted.error.message);
    }
    const run = submitted.data as {
      agentId: string;
      agentTaskId: string;
      attempt: number;
      status: "queued" | "running";
    };

    // 3. Poll for the terminal result (the Worker has no event bridge yet).
    //    pollResult never rejects: connection errors surface as a failed
    //    result instead of an unhandled rejection.
    const promise = this.pollResult(run.agentTaskId);
    promise.catch(() => {
      // Safety net: pollResult swallows its own errors; this keeps any
      // unexpected rejection from becoming an unhandled rejection.
    });
    return {
      agentTaskId: run.agentTaskId,
      agentId: run.agentId,
      attempt: run.attempt,
      status: run.status,
      promise,
    };
  }

  async cancel(agentId: string): Promise<void> {
    const response = await this.request({ type: "cancel_agent", agentId });
    if (!response.ok) {
      throw new WorkerRunError(response.error.code, response.error.message);
    }
  }

  private async pollResult(agentTaskId: string): Promise<AgentResult> {
    const deadline = Date.now() + this.resultTimeoutMs;
    for (;;) {
      let response: ControlPlaneResponse | undefined;
      try {
        response = await this.request({ type: "get_result", agentTaskId });
      } catch {
        // The Worker may have died mid-poll; treat it as "no result yet".
        response = undefined;
      }
      if (response?.ok) {
        const result = response.data as AgentResult | null;
        if (result && TERMINAL_RESULT_STATUSES.has(result.status)) {
          return result;
        }
      }
      if (Date.now() >= deadline) {
        return {
          agentId: "",
          agentTaskId,
          status: "failed",
          changedFiles: [],
          tests: [],
          risks: [],
          error: {
            code: "worker_result_timeout",
            message: `Worker did not finish task ${agentTaskId} within ${this.resultTimeoutMs}ms`,
          },
        };
      }
      await delay(this.pollIntervalMs);
    }
  }

  private async request(input: Record<string, unknown>): Promise<ControlPlaneResponse> {
    return this.worker.request({
      version: CONTROL_PLANE_VERSION,
      requestId: `wrm_${randomUUID()}`,
      ...input,
    } as ControlPlaneRequest);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * WorkerRunPool: distributes Run tasks across several Worker processes with
 * a per-worker concurrency bound. Workers are picked round-robin among those
 * with a free slot; when all are busy the task waits in FIFO order.
 */
export interface WorkerRunPoolOptions {
  workers: readonly RunTaskManager[];
  maxConcurrentPerWorker?: number;
}

export class WorkerRunPool implements RunTaskManager {
  private readonly workers: readonly RunTaskManager[];
  private readonly maxConcurrentPerWorker: number;
  private readonly active = new Map<RunTaskManager, number>();
  private readonly waiters: Array<() => void> = [];
  private nextIndex = 0;

  constructor(options: WorkerRunPoolOptions) {
    if (options.workers.length === 0) {
      throw new WorkerRunError("worker_pool_empty", "WorkerRunPool needs at least one worker");
    }
    this.workers = [...options.workers];
    this.maxConcurrentPerWorker = options.maxConcurrentPerWorker ?? 1;
  }

  async runBackground(
    profile: AgentProfile,
    task: AgentTask,
    options: AgentRunOptions,
  ): Promise<BackgroundAgentRun> {
    const worker = await this.acquireWorker();
    let run: BackgroundAgentRun;
    try {
      run = await worker.runBackground(profile, task, options);
    } catch (error) {
      this.releaseWorker(worker);
      throw error;
    }
    // The slot stays occupied until the task actually finishes inside the
    // Worker (its own queue may still be running earlier submissions).
    const promise = run.promise.finally(() => this.releaseWorker(worker));
    return { ...run, promise };
  }

  async cancel(agentId: string): Promise<void> {
    // The task may live on any Worker; broadcast the cancel.
    for (const worker of this.workers) {
      try {
        await worker.cancel(agentId);
      } catch {
        // A worker that never saw this Agent ignores the cancel.
      }
    }
  }

  /** Number of currently in-flight tasks across all workers. */
  inFlight(): number {
    let total = 0;
    for (const count of this.active.values()) total += count;
    return total;
  }

  private async acquireWorker(): Promise<RunTaskManager> {
    for (;;) {
      for (let offset = 0; offset < this.workers.length; offset++) {
        const index = (this.nextIndex + offset) % this.workers.length;
        const worker = this.workers[index]!;
        if ((this.active.get(worker) ?? 0) < this.maxConcurrentPerWorker) {
          this.nextIndex = (index + 1) % this.workers.length;
          this.active.set(worker, (this.active.get(worker) ?? 0) + 1);
          return worker;
        }
      }
      await this.waitForSlot();
    }
  }

  private releaseWorker(worker: RunTaskManager): void {
    const count = (this.active.get(worker) ?? 0) - 1;
    if (count <= 0) {
      this.active.delete(worker);
    } else {
      this.active.set(worker, count);
    }
    const waiter = this.waiters.shift();
    waiter?.();
  }

  private waitForSlot(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
