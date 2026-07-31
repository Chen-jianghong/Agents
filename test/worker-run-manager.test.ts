import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiAgentRuntime, type AgentProfile, type AgentResult, type AgentTask } from "../src/index.js";
import type { AgentRunOptions, BackgroundAgentRun } from "../src/manager.js";
import type { RunTaskManager } from "../src/run-scheduler.js";
import { WorkerRunPool, WorkerRunTaskManager } from "../src/worker-run-manager.js";
import { ControlPlaneWorkerProcess } from "../src/worker-process.js";

// Examples live in the project root; tests run from the repository root.
const WORKER_ENTRY = join(process.cwd(), "examples", "worker-entry.mjs");

function task(id: string, workspace: string): AgentTask {
  return {
    id,
    workspace,
    task: `Task ${id}`,
    acceptanceCriteria: ["Return evidence"],
    depth: 0,
  };
}

function completedResult(agentTaskId: string): AgentResult {
  return {
    agentId: "agent",
    agentTaskId,
    status: "completed",
    output: "ok",
    changedFiles: [],
    tests: [],
    risks: [],
  };
}

/** Manually controlled worker for pool scheduling tests. */
class FakeWorker implements RunTaskManager {
  readonly calls: Array<{ profile: AgentProfile; task: AgentTask; resolve: (r: AgentResult) => void; promise: Promise<AgentResult> }> = [];
  readonly cancelled: string[] = [];
  private resolve!: (r: AgentResult) => void;

  async runBackground(profile: AgentProfile, task: AgentTask, _options: AgentRunOptions): Promise<BackgroundAgentRun> {
    const promise = new Promise<AgentResult>((resolve) => {
      this.resolve = resolve;
    });
    this.calls.push({ profile, task, resolve: this.resolve, promise });
    return {
      agentTaskId: task.id,
      agentId: profile.id,
      attempt: 1,
      status: "running",
      promise,
    };
  }

  async cancel(agentId: string): Promise<void> {
    this.cancelled.push(agentId);
  }

  complete(id: string): void {
    const call = this.calls.find((item) => item.task.id === id);
    call?.resolve(completedResult(id));
  }
}

describe("WorkerRunPool", () => {
  it("distributes tasks round-robin and waits for a free slot", async () => {
    const w0 = new FakeWorker();
    const w1 = new FakeWorker();
    const pool = new WorkerRunPool({ workers: [w0, w1], maxConcurrentPerWorker: 1 });

    const r1 = await pool.runBackground({ id: "p1" } as AgentProfile, task("t1", "ws"), { cwd: "ws", agentDir: "ws/.pi" });
    const r2 = await pool.runBackground({ id: "p2" } as AgentProfile, task("t2", "ws"), { cwd: "ws", agentDir: "ws/.pi" });
    // Both workers are now busy: the third task must wait.
    const r3Promise = pool.runBackground({ id: "p3" } as AgentProfile, task("t3", "ws"), { cwd: "ws", agentDir: "ws/.pi" });

    assert.equal(w0.calls.length, 1);
    assert.equal(w1.calls.length, 1);
    assert.equal(pool.inFlight(), 2);

    // Finish t1 on w0 -> frees a slot -> t3 goes to w0 (round-robin continues).
    w0.complete("t1");
    const r3 = await r3Promise;
    assert.equal(w0.calls.length, 2);
    assert.equal(w1.calls.length, 1);
    assert.equal(w0.calls[1]?.task.id, "t3");

    w1.complete("t2");
    w0.complete("t3");
    assert.equal((await r1.promise).status, "completed");
    assert.equal((await r2.promise).status, "completed");
    assert.equal((await r3.promise).status, "completed");
    assert.equal(pool.inFlight(), 0);
  });

  it("allows multiple concurrent tasks per worker", async () => {
    const w0 = new FakeWorker();
    const pool = new WorkerRunPool({ workers: [w0], maxConcurrentPerWorker: 2 });

    const r1 = await pool.runBackground({ id: "p1" } as AgentProfile, task("t1", "ws"), { cwd: "ws", agentDir: "ws/.pi" });
    const r2 = await pool.runBackground({ id: "p2" } as AgentProfile, task("t2", "ws"), { cwd: "ws", agentDir: "ws/.pi" });
    assert.equal(w0.calls.length, 2);

    w0.complete("t1");
    w0.complete("t2");
    assert.equal((await r1.promise).status, "completed");
    assert.equal((await r2.promise).status, "completed");
  });

  it("broadcasts cancel to every worker", async () => {
    const w0 = new FakeWorker();
    const w1 = new FakeWorker();
    const pool = new WorkerRunPool({ workers: [w0, w1] });
    await pool.cancel("agent-1");
    assert.deepEqual(w0.cancelled, ["agent-1"]);
    assert.deepEqual(w1.cancelled, ["agent-1"]);
  });
});

describe("WorkerRunTaskManager (real Worker process)", () => {
  it("runs a task inside an independent Worker process with the faux provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrm-e2e-"));
    const worker = new ControlPlaneWorkerProcess({
      command: process.execPath,
      args: [WORKER_ENTRY],
      env: {
        WORKER_TOKEN: "test-token",
        WORKER_WORKSPACE: root,
        WORKER_FAUX: "1",
        PATH: process.env.PATH ?? "",
      },
      token: "test-token",
      startupTimeoutMs: 15_000,
      shutdownTimeoutMs: 5_000,
    });
    try {
      await worker.start();
      const manager = new WorkerRunTaskManager({
        worker,
        pollIntervalMs: 50,
        resultTimeoutMs: 30_000,
      });

      const runtime = createMultiAgentRuntime();
      const researcher = runtime.registry.get("researcher");
      const run = await manager.runBackground(researcher, task("wrm-task", root), {
        cwd: root,
        agentDir: join(root, ".pi"),
      });
      assert.equal(run.agentId, researcher.id);

      const result = await run.promise;
      assert.equal(result.status, "completed");
    } finally {
      await worker.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails fast when the Worker process is not running", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrm-err-"));
    const worker = new ControlPlaneWorkerProcess({
      command: process.execPath,
      args: [WORKER_ENTRY],
      env: {
        WORKER_TOKEN: "test-token",
        WORKER_WORKSPACE: root,
        WORKER_FAUX: "1",
        PATH: process.env.PATH ?? "",
      },
      token: "test-token",
      startupTimeoutMs: 15_000,
      shutdownTimeoutMs: 5_000,
    });
    try {
      const manager = new WorkerRunTaskManager({ worker, pollIntervalMs: 50, resultTimeoutMs: 10_000 });
      const runtime = createMultiAgentRuntime();
      const researcher = runtime.registry.get("researcher");
      await assert.rejects(
        manager.runBackground(researcher, task("wrm-down", root), { cwd: root, agentDir: join(root, ".pi") }),
        (error: unknown) => error instanceof Error && /not running/i.test(error.message),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
