import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createMultiAgentRuntime } from "../src/index.js";
import { PlannerService } from "../src/planner.js";
import { RunScheduler } from "../src/run-scheduler.js";
import { WorkerRunTaskManager } from "../src/worker-run-manager.js";
import { ControlPlaneWorkerProcess } from "../src/worker-process.js";
import type { TaskDAG } from "../src/plan-contracts.js";

const WORKER_ENTRY = join(process.cwd(), "examples", "worker-entry.mjs");

const DAG: TaskDAG = {
  goal: "Implement members management",
  tasks: [
    {
      id: "backend",
      title: "Implement the members API",
      role: "backend",
      dependsOn: [],
      writePaths: ["server/modules/members"],
      acceptanceCriteria: ["list endpoint returns members"],
      testCommands: ["npm test"],
    },
    {
      id: "qa",
      title: "Verify the members API",
      role: "qa",
      dependsOn: ["backend"],
      writePaths: [],
      acceptanceCriteria: ["tests pass"],
      testCommands: ["npm test"],
    },
  ],
};

describe("Phase D integration (Run tasks in a Worker process)", () => {
  it("runs a full planned Run with tasks executed inside a Worker process", async () => {
    const root = await mkdtemp(join(tmpdir(), "phase-d-"));
    const faux = fauxProvider({ provider: "host-faux-d", models: [{ id: "faux-model", reasoning: false }] });
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const aliases = {
      "coding-strong": "host-faux-d/faux-model",
      "coding-balanced": "host-faux-d/faux-model",
    };

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
      faux.setResponses([fauxAssistantMessage(JSON.stringify(DAG))]);

      const runtime = createMultiAgentRuntime({ modelRuntime, modelAliases: aliases });
      const planner = new PlannerService(runtime.sessionFactory, {
        cwd: root,
        agentDir: join(root, "pi"),
        modelRuntime,
        modelAliases: aliases,
      });
      const workerManager = new WorkerRunTaskManager({ worker, pollIntervalMs: 50, resultTimeoutMs: 30_000 });
      const scheduler = new RunScheduler({
        planner,
        manager: workerManager,
        factory: runtime.factory,
        registry: runtime.registry,
        modelRuntime,
        modelAliases: aliases,
        maxParallel: 1,
      });

      const run = scheduler.createRun({
        goal: DAG.goal,
        workspace: root,
        agentDir: join(root, "pi"),
        maxParallel: 1,
      });
      await scheduler.startRun(run.runId);
      const result = await scheduler.waitForRun(run.runId);

      assert.equal(result.status, "succeeded");
      assert.deepEqual(result.tasks.map((t) => [t.taskId, t.status]), [
        ["backend", "succeeded"],
        ["qa", "succeeded"],
      ]);
      // The Worker executed the tasks: agent ids are the registered snapshots.
      for (const task of result.tasks) {
        assert.ok(task.agentTaskId, `task ${task.taskId} has an agentTaskId`);
      }
    } finally {
      await worker.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates task failure from the Worker into the Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "phase-d-fail-"));
    const faux = fauxProvider({ provider: "host-faux-d2", models: [{ id: "faux-model", reasoning: false }] });
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const aliases = {
      "coding-strong": "host-faux-d2/faux-model",
      "coding-balanced": "host-faux-d2/faux-model",
    };

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

      const runtime = createMultiAgentRuntime({ modelRuntime, modelAliases: aliases });
      // Deterministic DAG with one task; planner stub keeps timing stable.
      const planner = { plan: async () => ({
        status: "planned" as const,
        dag: { goal: DAG.goal, tasks: [DAG.tasks[0]!] },
        validation: { valid: true, issues: [], topoOrder: ["backend"] },
        rawOutput: "",
      }) };
      const workerManager = new WorkerRunTaskManager({ worker, pollIntervalMs: 50, resultTimeoutMs: 30_000 });
      const scheduler = new RunScheduler({
        planner,
        manager: workerManager,
        factory: runtime.factory,
        registry: runtime.registry,
        modelRuntime,
        modelAliases: aliases,
        maxParallel: 1,
      });

      const run = scheduler.createRun({
        goal: DAG.goal,
        workspace: root,
        agentDir: join(root, "pi"),
        maxParallel: 1,
      });
      await scheduler.startRun(run.runId);
      // Kill the Worker while the task is still executing: the poll fails
      // and the Run surfaces the task as failed.
      await worker.stop();
      const result = await scheduler.waitForRun(run.runId);

      assert.equal(result.status, "failed");
      const failedTask = result.tasks[0];
      assert.equal(failedTask?.status, "failed");
      assert.ok(failedTask?.error, "task reports an error");
    } finally {
      await worker.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
