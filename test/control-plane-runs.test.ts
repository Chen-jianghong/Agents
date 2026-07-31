import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AgentControlPlane,
  CONTROL_PLANE_VERSION,
  createMultiAgentRuntime,
  PiAgentManager,
  RunScheduler,
  type AgentProfile,
  type AgentTask,
  type ManagedAgent,
  type PlanOutcome,
  type PlanPlanner,
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
    {
      id: "qa",
      title: "Verify the members API",
      role: "qa",
      dependsOn: ["backend"],
      writePaths: [],
      acceptanceCriteria: ["tests pass for the members module"],
      testCommands: ["npm test -- members"],
    },
  ],
};

const PLANNED: PlanOutcome = {
  status: "planned",
  dag: VALID_DAG,
  validation: { valid: true, issues: [], topoOrder: ["backend", "qa"] },
  rawOutput: JSON.stringify(VALID_DAG),
};

function fakePlanner(outcome: PlanOutcome): PlanPlanner {
  return { plan: async () => outcome };
}

function deferredPlanner(): { planner: PlanPlanner; resolve: (outcome: PlanOutcome) => void } {
  let resolveFn!: (outcome: PlanOutcome) => void;
  const planner: PlanPlanner = {
    plan: () => new Promise<PlanOutcome>((res) => { resolveFn = res; }),
  };
  const resolve = (outcome: PlanOutcome) => {
    if (typeof resolveFn !== "function") throw new Error("plan() has not been called yet");
    resolveFn(outcome);
  };
  return { planner, resolve };
}

function fakeManagedAgent(
  childProfile: AgentProfile,
  childTask: AgentTask,
  run: () => Promise<void>,
): ManagedAgent {
  return {
    agentId: childProfile.id,
    sessionId: `session-${childTask.id}`,
    profile: childProfile,
    session: {} as never,
    status: "created",
    prompt: async () => {
      await run();
      return {
        agentId: childProfile.id,
        agentTaskId: childTask.id,
        status: "completed",
        changedFiles: [],
        tests: [],
        risks: [],
      };
    },
    cancel: async () => undefined,
    subscribe: () => () => undefined,
  };
}

function fakeManager() {
  return new PiAgentManager({
    create: async (childProfile: AgentProfile, childTask: AgentTask) =>
      fakeManagedAgent(childProfile, childTask, async () => undefined),
  });
}

function makeScheduler(planner: PlanPlanner, maxParallel = 2) {
  const runtime = createMultiAgentRuntime();
  const manager = fakeManager();
  const scheduler = new RunScheduler({
    planner,
    manager,
    factory: runtime.factory,
    registry: runtime.registry,
    maxParallel,
  });
  return { runtime, manager, scheduler };
}

function makeControlPlane(
  scheduler: RunScheduler | undefined,
  execution: { cwd: string; agentDir: string } | undefined,
) {
  const runtime = createMultiAgentRuntime();
  const manager = fakeManager();
  const controlPlane = new AgentControlPlane(runtime.registry, manager, {
    factory: runtime.factory,
    ...(execution ? { execution } : {}),
    ...(scheduler ? { runScheduler: scheduler } : {}),
  });
  return controlPlane;
}

const EXECUTION = { cwd: process.cwd(), agentDir: join(tmpdir(), "cp-runs-pi") };

describe("Control Plane Run/DAG commands", () => {
  it("creates a Run through the Control Plane with host execution defaults", async () => {
    const { scheduler } = makeScheduler(fakePlanner(PLANNED));
    const controlPlane = makeControlPlane(scheduler, EXECUTION);

    const created = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-1",
      type: "create_run",
      goal: VALID_DAG.goal,
      workspace: process.cwd(),
      maxParallel: 3,
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("create_run failed");
    const snapshot = created.data as { runId: string; status: string; maxParallel: number };
    assert.equal(snapshot.status, "created");
    assert.equal(snapshot.maxParallel, 3);
    assert.match(snapshot.runId, /^run_/);
  });

  it("rejects create_run when the workspace does not match host execution", async () => {
    const { scheduler } = makeScheduler(fakePlanner(PLANNED));
    const controlPlane = makeControlPlane(scheduler, EXECUTION);

    const response = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-bad-workspace",
      type: "create_run",
      goal: "x",
      workspace: join(process.cwd(), "other-workspace"),
    });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, "run_workspace_mismatch");
  });

  it("rejects Run commands when the scheduler is not configured", async () => {
    const controlPlane = makeControlPlane(undefined, EXECUTION);

    const created = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-unavailable",
      type: "create_run",
      goal: "x",
      workspace: process.cwd(),
    });
    assert.equal(created.ok, false);
    if (!created.ok) assert.equal(created.error.code, "run_submission_unavailable");

    const listed = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "list-unavailable",
      type: "list_runs",
    });
    assert.equal(listed.ok, false);
    if (!listed.ok) assert.equal(listed.error.code, "run_scheduler_unavailable");
  });

  it("starts a Run asynchronously and reports planning immediately", async () => {
    const { scheduler } = makeScheduler(fakePlanner(PLANNED));
    const controlPlane = makeControlPlane(scheduler, EXECUTION);

    const created = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-2",
      type: "create_run",
      goal: VALID_DAG.goal,
      workspace: process.cwd(),
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("create_run failed");
    const runId = (created.data as { runId: string }).runId;

    // start_run returns immediately: the Run is already in "planning".
    const started = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "start-2",
      type: "start_run",
      runId,
    });
    assert.equal(started.ok, true);
    if (!started.ok) throw new Error("start_run failed");
    const snapshot = started.data as { runId: string; status: string };
    assert.equal(snapshot.runId, runId);
    assert.equal(snapshot.status, "planning");

    const result = await scheduler.waitForRun(runId);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.tasks.map((t) => [t.taskId, t.status]), [
      ["backend", "succeeded"],
      ["qa", "succeeded"],
    ]);
  });

  it("start_run is idempotent for an already started Run", async () => {
    const { scheduler } = makeScheduler(fakePlanner(PLANNED));
    const controlPlane = makeControlPlane(scheduler, EXECUTION);

    const created = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-3",
      type: "create_run",
      goal: VALID_DAG.goal,
      workspace: process.cwd(),
    });
    if (!created.ok) throw new Error("create_run failed");
    const runId = (created.data as { runId: string }).runId;

    await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "start-3a",
      type: "start_run",
      runId,
    });
    const secondStart = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "start-3b",
      type: "start_run",
      runId,
    });
    assert.equal(secondStart.ok, true);
    if (!secondStart.ok) throw new Error("second start_run failed");
    // Returns the current snapshot instead of restarting.
    assert.equal((secondStart.data as { runId: string }).runId, runId);

    await scheduler.waitForRun(runId);
    const afterTerminal = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "start-3c",
      type: "start_run",
      runId,
    });
    assert.equal(afterTerminal.ok, true);
    if (!afterTerminal.ok) throw new Error("terminal start_run failed");
    assert.equal((afterTerminal.data as { status: string }).status, "succeeded");
  });

  it("queries Runs by id and lists all Runs", async () => {
    const { scheduler } = makeScheduler(fakePlanner(PLANNED));
    const controlPlane = makeControlPlane(scheduler, EXECUTION);

    await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-4",
      type: "create_run",
      goal: "First goal",
      workspace: process.cwd(),
    });
    await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-5",
      type: "create_run",
      goal: "Second goal",
      workspace: process.cwd(),
    });

    const listed = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "list-4",
      type: "list_runs",
    });
    assert.equal(listed.ok, true);
    if (!listed.ok) throw new Error("list_runs failed");
    assert.equal((listed.data as unknown[]).length, 2);

    const firstRunId = (listed.data as Array<{ runId: string }>)[0]!.runId;
    const got = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "get-4",
      type: "get_run",
      runId: firstRunId,
    });
    assert.equal(got.ok, true);
    if (!got.ok) throw new Error("get_run failed");
    assert.equal((got.data as { runId: string }).runId, firstRunId);

    const missing = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "get-missing",
      type: "get_run",
      runId: "run_nope",
    });
    assert.equal(missing.ok, true);
    if (!missing.ok) throw new Error("get_run(missing) failed");
    assert.equal(missing.data, null);
  });

  it("cancels a Run during planning and never schedules its tasks", async () => {
    const { planner, resolve } = deferredPlanner();
    const { scheduler } = makeScheduler(planner);
    const controlPlane = makeControlPlane(scheduler, EXECUTION);

    const created = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-6",
      type: "create_run",
      goal: VALID_DAG.goal,
      workspace: process.cwd(),
    });
    if (!created.ok) throw new Error("create_run failed");
    const runId = (created.data as { runId: string }).runId;

    const events: string[] = [];
    controlPlane.subscribe((event) => events.push(event.type));

    await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "start-6",
      type: "start_run",
      runId,
    });

    // Cancel while the planner is still running.
    const cancelled = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "cancel-6",
      type: "cancel_run",
      runId,
    });
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) throw new Error("cancel_run failed");
    assert.deepEqual(cancelled.data, { runId, status: "cancel_requested" });

    // The planner eventually returns; the Run must finalize as cancelled
    // without scheduling any task.
    resolve(PLANNED);
    const result = await scheduler.waitForRun(runId);
    assert.equal(result.status, "cancelled");
    assert.ok(!events.includes("task.running"), "no task may run after a planning cancel");
    assert.ok(!events.includes("run.started"), "run.started must not be emitted");
    assert.ok(events.includes("run.cancelled"), "run.cancelled must be emitted");
  });

  it("cancels a Run that is already running", async () => {
    const { scheduler } = makeScheduler(fakePlanner(PLANNED));
    const controlPlane = makeControlPlane(scheduler, EXECUTION);

    const created = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-7",
      type: "create_run",
      goal: VALID_DAG.goal,
      workspace: process.cwd(),
    });
    if (!created.ok) throw new Error("create_run failed");
    const runId = (created.data as { runId: string }).runId;

    await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "start-7",
      type: "start_run",
      runId,
    });
    const result = await scheduler.waitForRun(runId);
    assert.equal(result.status, "succeeded");

    // Cancelling a terminal Run is a no-op that still acknowledges.
    const cancelled = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "cancel-7",
      type: "cancel_run",
      runId,
    });
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) throw new Error("cancel_run failed");
    assert.deepEqual(cancelled.data, { runId, status: "cancel_requested" });
  });

  it("validates create_run request fields", async () => {
    const { scheduler } = makeScheduler(fakePlanner(PLANNED));
    const controlPlane = makeControlPlane(scheduler, EXECUTION);

    const noGoal = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-bad-1",
      type: "create_run",
      workspace: process.cwd(),
    });
    assert.equal(noGoal.ok, false);
    if (!noGoal.ok) assert.equal(noGoal.error.code, "invalid_request");

    const badParallel = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-bad-2",
      type: "create_run",
      goal: "x",
      workspace: process.cwd(),
      maxParallel: 0,
    });
    assert.equal(badParallel.ok, false);
    if (!badParallel.ok) assert.equal(badParallel.error.code, "invalid_request");

    const badProfile = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-bad-3",
      type: "create_run",
      goal: "x",
      workspace: process.cwd(),
      plannerModelProfile: "",
    });
    assert.equal(badProfile.ok, false);
    if (!badProfile.ok) assert.equal(badProfile.error.code, "invalid_request");
  });

  it("rejects start_run and cancel_run for unknown Runs", async () => {
    const { scheduler } = makeScheduler(fakePlanner(PLANNED));
    const controlPlane = makeControlPlane(scheduler, EXECUTION);

    const startMissing = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "start-missing",
      type: "start_run",
      runId: "run_nope",
    });
    assert.equal(startMissing.ok, false);
    if (!startMissing.ok) assert.equal(startMissing.error.code, "run_not_found");

    const cancelMissing = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "cancel-missing",
      type: "cancel_run",
      runId: "run_nope",
    });
    assert.equal(cancelMissing.ok, false);
    if (!cancelMissing.ok) assert.equal(cancelMissing.error.code, "run_not_found");
  });

  it("sends Run events through the Control Plane subscription", async () => {
    const { scheduler } = makeScheduler(fakePlanner(PLANNED));
    const controlPlane = makeControlPlane(scheduler, EXECUTION);

    const events: string[] = [];
    controlPlane.subscribe((event) => events.push(event.type));

    const created = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "create-8",
      type: "create_run",
      goal: VALID_DAG.goal,
      workspace: process.cwd(),
    });
    if (!created.ok) throw new Error("create_run failed");
    const runId = (created.data as { runId: string }).runId;

    await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "start-8",
      type: "start_run",
      runId,
    });
    await scheduler.waitForRun(runId);

    assert.ok(events.includes("run.created"), "run.created expected");
    assert.ok(events.includes("run.planning_started"), "run.planning_started expected");
    assert.ok(events.includes("run.ready"), "run.ready expected");
    assert.ok(events.includes("task.running"), "task.running expected");
    assert.ok(events.includes("task.succeeded"), "task.succeeded expected");
    assert.ok(events.includes("run.succeeded"), "run.succeeded expected");
  });
});

describe("Runtime Control Plane RunScheduler wiring", () => {
  it("mounts a shared RunScheduler from controlPlaneExecution and runs a full loop", async () => {
    const faux = fauxProvider({
      provider: "faux-cp-runs",
      models: [{ id: "faux-model", reasoning: false }],
    });
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const aliases = {
      "coding-strong": "faux-cp-runs/faux-model",
      "coding-balanced": "faux-cp-runs/faux-model",
    };
    const root = await mkdtemp(join(tmpdir(), "cp-runs-e2e-"));
    try {
      // Serial responses: planner DAG, then backend task, then qa task.
      faux.setResponses([
        fauxAssistantMessage(JSON.stringify(VALID_DAG)),
        fauxAssistantMessage("Backend task completed."),
        fauxAssistantMessage("QA verification passed."),
      ]);

      const runtime = createMultiAgentRuntime({
        modelRuntime,
        modelAliases: aliases,
        controlPlaneExecution: { cwd: process.cwd(), agentDir: join(root, "pi") },
        controlPlaneScheduler: { maxParallel: 2 },
      });
      assert.ok(runtime.controlPlaneScheduler, "controlPlaneScheduler must be exposed");

      const created = await runtime.controlPlane.handle({
        version: CONTROL_PLANE_VERSION,
        requestId: "e2e-create",
        type: "create_run",
        goal: VALID_DAG.goal,
        workspace: process.cwd(),
      });
      assert.equal(created.ok, true);
      if (!created.ok) throw new Error("create_run failed");
      const runId = (created.data as { runId: string }).runId;

      const started = await runtime.controlPlane.handle({
        version: CONTROL_PLANE_VERSION,
        requestId: "e2e-start",
        type: "start_run",
        runId,
      });
      assert.equal(started.ok, true);

      const result = await runtime.controlPlaneScheduler!.waitForRun(runId);
      assert.equal(result.status, "succeeded");
      assert.deepEqual(result.tasks.map((t) => [t.taskId, t.status]), [
        ["backend", "succeeded"],
        ["qa", "succeeded"],
      ]);
      assert.equal(faux.state.callCount, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not mount a RunScheduler without controlPlaneExecution", async () => {
    const runtime = createMultiAgentRuntime({ controlPlaneScheduler: true });
    assert.equal(runtime.controlPlaneScheduler, undefined);
    const response = await runtime.controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "no-exec",
      type: "create_run",
      goal: "x",
      workspace: process.cwd(),
    });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, "run_submission_unavailable");
  });
});
