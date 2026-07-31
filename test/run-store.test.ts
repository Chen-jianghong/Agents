import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  CONTROL_PLANE_VERSION,
  createMultiAgentRuntimeAsync,
  createMultiAgentRuntime,
  FileRunStore,
  PiAgentManager,
  RunScheduler,
  type AgentProfile,
  type AgentTask,
  type ManagedAgent,
  type PlanOutcome,
  type PlanPlanner,
  type RunSnapshot,
  type TaskDAG,
} from "../src/index.js";

const VALID_DAG: TaskDAG = {
  goal: "Implement members management",
  tasks: [
    {
      id: "backend",
      title: "Implement the members API",
      role: "backend",
      dependsOn: [],
      writePaths: ["server/modules/members"],
      acceptanceCriteria: ["the list endpoint returns members"],
      testCommands: ["npm test -- members"],
    },
  ],
};

const PLANNED: PlanOutcome = {
  status: "planned",
  dag: VALID_DAG,
  validation: { valid: true, issues: [], topoOrder: ["backend"] },
  rawOutput: JSON.stringify(VALID_DAG),
};

function fakePlanner(outcome: PlanOutcome): PlanPlanner {
  return { plan: async () => outcome };
}

function fakeManagedAgent(
  childProfile: AgentProfile,
  childTask: AgentTask,
): ManagedAgent {
  return {
    agentId: childProfile.id,
    sessionId: `session-${childTask.id}`,
    profile: childProfile,
    session: {} as never,
    status: "created",
    prompt: async () => ({
      agentId: childProfile.id,
      agentTaskId: childTask.id,
      status: "completed",
      changedFiles: [],
      tests: [],
      risks: [],
    }),
    cancel: async () => undefined,
    subscribe: () => () => undefined,
  };
}

function makeScheduler(planner: PlanPlanner, runStore?: FileRunStore) {
  const runtime = createMultiAgentRuntime();
  const manager = new PiAgentManager({
    create: async (childProfile: AgentProfile, childTask: AgentTask) =>
      fakeManagedAgent(childProfile, childTask),
  });
  const scheduler = new RunScheduler({
    planner,
    manager,
    factory: runtime.factory,
    registry: runtime.registry,
    maxParallel: 2,
    ...(runStore ? { runStore } : {}),
  });
  return scheduler;
}

function terminalSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  const now = new Date().toISOString();
  return {
    runId: "run_done",
    status: "succeeded",
    goal: VALID_DAG.goal,
    workspace: process.cwd(),
    maxParallel: 2,
    dag: VALID_DAG,
    tasks: [
      {
        taskId: "backend",
        title: VALID_DAG.tasks[0]!.title,
        role: "backend",
        status: "succeeded",
        dependsOn: [],
        writePaths: ["server/modules/members"],
      },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("FileRunStore", () => {
  it("round-trips Run snapshots and removes them", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-store-"));
    try {
      const store = new FileRunStore(join(root, "runs"));
      const snapshot = terminalSnapshot();
      await store.save(snapshot);

      const listed = await store.list();
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.runId, "run_done");
      assert.equal(listed[0]!.status, "succeeded");

      await store.remove("run_done");
      assert.equal((await store.list()).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an empty list for a missing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-store-empty-"));
    try {
      const store = new FileRunStore(join(root, "does-not-exist"));
      assert.deepEqual(await store.list(), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("RunScheduler persistence", () => {
  it("restores terminal Runs as-is and resolves waitForRun immediately", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-persist-"));
    try {
      const store = new FileRunStore(join(root, "runs"));
      const scheduler = makeScheduler(fakePlanner(PLANNED), store);
      const run = scheduler.createRun({
        goal: VALID_DAG.goal,
        workspace: process.cwd(),
      });
      await scheduler.startRun(run.runId);
      const result = await scheduler.waitForRun(run.runId);
      assert.equal(result.status, "succeeded");
      await scheduler.flush();

      // A fresh scheduler loads the persisted Run from disk.
      const fresh = makeScheduler(fakePlanner(PLANNED), store);
      const restored = await fresh.loadRuns();
      assert.equal(restored.length, 1);
      assert.equal(restored[0]!.runId, run.runId);
      assert.equal(restored[0]!.status, "succeeded");
      assert.equal(restored[0]!.tasks[0]!.status, "succeeded");

      // waitForRun resolves immediately for a restored terminal Run.
      const restoredResult = await fresh.waitForRun(run.runId);
      assert.equal(restoredResult.status, "succeeded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks interrupted Runs as failed with host_restarted", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-interrupted-"));
    try {
      const store = new FileRunStore(join(root, "runs"));
      const now = new Date().toISOString();
      const interrupted: RunSnapshot = {
        runId: "run_interrupted",
        status: "running",
        goal: VALID_DAG.goal,
        workspace: process.cwd(),
        maxParallel: 2,
        dag: VALID_DAG,
        tasks: [
          {
            taskId: "backend",
            title: VALID_DAG.tasks[0]!.title,
            role: "backend",
            status: "running",
            dependsOn: [],
            writePaths: ["server/modules/members"],
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      await store.save(interrupted);

      const scheduler = makeScheduler(fakePlanner(PLANNED), store);
      await scheduler.loadRuns();
      const restored = scheduler.getRun("run_interrupted");
      assert.equal(restored?.status, "failed");
      assert.equal(restored?.error?.code, "host_restarted");

      // The failed Run also resolves waitForRun.
      const result = await scheduler.waitForRun("run_interrupted");
      assert.equal(result.status, "failed");
      assert.equal(result.error?.code, "host_restarted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loadRuns is a no-op without a run store", async () => {
    const scheduler = makeScheduler(fakePlanner(PLANNED));
    assert.deepEqual(await scheduler.loadRuns(), []);
  });

  it("createMultiAgentRuntimeAsync restores Runs through the Control Plane", async () => {
    const faux = fauxProvider({
      provider: "faux-run-restore",
      models: [{ id: "faux-model", reasoning: false }],
    });
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const aliases = {
      "coding-strong": "faux-run-restore/faux-model",
      "coding-balanced": "faux-run-restore/faux-model",
    };
    const root = await mkdtemp(join(tmpdir(), "run-restore-e2e-"));
    try {
      faux.setResponses([
        fauxAssistantMessage(JSON.stringify(VALID_DAG)),
        fauxAssistantMessage("Backend task completed."),
      ]);
      const runStore = new FileRunStore(join(root, "runs"));

      const runtime = await createMultiAgentRuntimeAsync({
        modelRuntime,
        modelAliases: aliases,
        runStore,
        controlPlaneExecution: { cwd: process.cwd(), agentDir: join(root, "pi") },
        controlPlaneScheduler: { maxParallel: 1 },
      });
      const created = await runtime.controlPlane.handle({
        version: CONTROL_PLANE_VERSION,
        requestId: "restore-create",
        type: "create_run",
        goal: VALID_DAG.goal,
        workspace: process.cwd(),
      });
      assert.equal(created.ok, true);
      if (!created.ok) throw new Error("create_run failed");
      const runId = (created.data as { runId: string }).runId;

      await runtime.controlPlane.handle({
        version: CONTROL_PLANE_VERSION,
        requestId: "restore-start",
        type: "start_run",
        runId,
      });
      const result = await runtime.controlPlaneScheduler!.waitForRun(runId);
      assert.equal(result.status, "succeeded");
      await runtime.controlPlane.flush();

      // A "restarted host": same runStore, fresh runtime instance.
      const restarted = await createMultiAgentRuntimeAsync({
        modelRuntime,
        modelAliases: aliases,
        runStore,
        controlPlaneExecution: { cwd: process.cwd(), agentDir: join(root, "pi") },
        controlPlaneScheduler: { maxParallel: 1 },
      });
      const restored = await restarted.controlPlane.handle({
        version: CONTROL_PLANE_VERSION,
        requestId: "restore-get",
        type: "get_run",
        runId,
      });
      assert.equal(restored.ok, true);
      if (!restored.ok) throw new Error("get_run failed");
      const snapshot = restored.data as { status: string; tasks: Array<{ status: string }> };
      assert.equal(snapshot.status, "succeeded");
      assert.equal(snapshot.tasks[0]!.status, "succeeded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
