import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentFactory, DEFAULT_FACTORY_POLICY, LayeredProfileRegistry, createBuiltInProfiles } from "../src/index.js";
import type { AgentProfile, AgentResult, AgentTask } from "../src/contracts.js";
import type { AgentRunOptions, BackgroundAgentRun } from "../src/manager.js";
import type { PlanOutcome, PlanTask, TaskDAG } from "../src/plan-contracts.js";
import type { PlanPlanner } from "../src/planner.js";
import { RunScheduler, type RunTaskManager } from "../src/run-scheduler.js";

function successResult(agentTaskId: string): AgentResult {
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

function failedResult(agentTaskId: string, code = "agent_execution_failed"): AgentResult {
  return {
    agentId: "agent",
    agentTaskId,
    status: "failed",
    changedFiles: [],
    tests: [],
    risks: [],
    error: { code, message: "boom" },
  };
}

interface FakeCall {
  profile: AgentProfile;
  task: AgentTask;
  options: AgentRunOptions;
  resolve: (result: AgentResult) => void;
  promise: Promise<AgentResult>;
}

class FakeManager implements RunTaskManager {
  readonly calls: FakeCall[] = [];
  readonly cancelledAgents: string[] = [];

  runBackground(profile: AgentProfile, task: AgentTask, options: AgentRunOptions): BackgroundAgentRun {
    let resolve!: (result: AgentResult) => void;
    const promise = new Promise<AgentResult>((res) => {
      resolve = res;
    });
    this.calls.push({ profile, task, options, resolve, promise });
    return {
      agentTaskId: task.id,
      agentId: profile.id,
      attempt: 1,
      status: "running",
      promise,
    };
  }

  complete(taskId: string, result?: AgentResult): void {
    const call = this.calls.find((item) => item.task.id === taskId);
    if (!call) throw new Error(`no fake call for ${taskId}`);
    call.resolve(result ?? successResult(taskId));
  }

  async cancel(agentId: string): Promise<void> {
    this.cancelledAgents.push(agentId);
    // Mirror the real Manager: aborting an Agent resolves its pending
    // task with a cancelled result.
    for (const call of this.calls) {
      if (call.profile.id === agentId) {
        call.resolve({
          agentId,
          agentTaskId: call.task.id,
          status: "cancelled",
          changedFiles: [],
          tests: [],
          risks: [],
          error: { code: "agent_cancelled", message: "cancelled by Run cancellation" },
        });
      }
    }
  }
}

/** Planner stub that returns a fixed outcome. */
function stubPlanner(outcome: PlanOutcome): PlanPlanner {
  return { plan: async () => outcome };
}

function planned(dag: TaskDAG): PlanOutcome {
  return { status: "planned", dag, validation: { valid: true, issues: [], topoOrder: dag.tasks.map((t) => t.id) }, rawOutput: "" };
}

function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: "t1",
    title: "Task 1",
    role: "backend",
    dependsOn: [],
    writePaths: ["server/modules/members"],
    acceptanceCriteria: ["implement"],
    testCommands: ["npm test"],
    ...overrides,
  };
}

function setup() {
  const registry = new LayeredProfileRegistry();
  for (const profile of createBuiltInProfiles()) registry.registerBuiltIn(profile);
  const factory = new AgentFactory(registry, DEFAULT_FACTORY_POLICY);
  const manager = new FakeManager();
  return { registry, factory, manager };
}

function makeScheduler(planner: PlanPlanner, manager: FakeManager) {
  const { registry, factory } = setup();
  const scheduler = new RunScheduler({ planner, manager, factory, registry });
  return scheduler;
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("RunScheduler", () => {
  it("succeeds when every task completes", async () => {
    const dag: TaskDAG = {
      goal: "Members feature",
      tasks: [
        task({ id: "backend", writePaths: ["server"] }),
        task({ id: "frontend", writePaths: ["web"] }),
        task({ id: "qa", role: "qa", dependsOn: ["backend", "frontend"], writePaths: [] }),
      ],
    };
    const manager = new FakeManager();
    const scheduler = makeScheduler(stubPlanner(planned(dag)), manager);

    const run = scheduler.createRun({ goal: dag.goal, workspace: "C:/ws/project" });
    await scheduler.startRun(run.runId);

    await waitFor(() => manager.calls.length >= 2);
    const backendCall = manager.calls.find((call) => call.task.taskId === "backend")!;
    const frontendCall = manager.calls.find((call) => call.task.taskId === "frontend")!;
    backendCall.resolve(successResult(backendCall.task.id));
    frontendCall.resolve(successResult(frontendCall.task.id));

    await waitFor(() => manager.calls.length >= 3);
    const qaCall = manager.calls.find((call) => call.task.taskId === "qa")!;
    qaCall.resolve(successResult(qaCall.task.id));

    const result = await scheduler.waitForRun(run.runId);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.tasks.map((t) => [t.taskId, t.status]), [
      ["backend", "succeeded"],
      ["frontend", "succeeded"],
      ["qa", "succeeded"],
    ]);
  });

  it("blocks dependent tasks when a dependency fails but lets independent tasks finish", async () => {
    const dag: TaskDAG = {
      goal: "Members feature",
      tasks: [
        task({ id: "backend", writePaths: ["server"] }),
        task({ id: "qa", role: "qa", dependsOn: ["backend"], writePaths: [] }),
        task({ id: "docs", writePaths: ["docs"] }),
      ],
    };
    const manager = new FakeManager();
    const scheduler = makeScheduler(stubPlanner(planned(dag)), manager);

    const run = scheduler.createRun({ goal: dag.goal, workspace: "C:/ws/project" });
    await scheduler.startRun(run.runId);

    await waitFor(() => manager.calls.length >= 2);
    const backendCall = manager.calls.find((call) => call.task.taskId === "backend")!;
    const docsCall = manager.calls.find((call) => call.task.taskId === "docs")!;
    backendCall.resolve(failedResult(backendCall.task.id));
    docsCall.resolve(successResult(docsCall.task.id));

    const result = await scheduler.waitForRun(run.runId);
    assert.equal(result.status, "failed");
    const byId = new Map(result.tasks.map((t) => [t.taskId, t]));
    assert.equal(byId.get("backend")?.status, "failed");
    assert.equal(byId.get("qa")?.status, "cancelled");
    assert.equal(byId.get("qa")?.error?.code, "dependency_failed");
    assert.equal(byId.get("docs")?.status, "succeeded");
  });

  it("fails a task whose role has no Agent Profile", async () => {
    const dag: TaskDAG = {
      goal: "x",
      tasks: [task({ id: "mystery", role: "no-such-role", writePaths: ["src"] })],
    };
    const manager = new FakeManager();
    const scheduler = makeScheduler(stubPlanner(planned(dag)), manager);

    const run = scheduler.createRun({ goal: dag.goal, workspace: "C:/ws/project" });
    await scheduler.startRun(run.runId);

    const result = await scheduler.waitForRun(run.runId);
    assert.equal(result.status, "failed");
    assert.equal(result.tasks[0]?.error?.code, "unknown_role");
    assert.equal(manager.calls.length, 0);
  });

  it("fails the Run when planning produces an invalid DAG", async () => {
    const manager = new FakeManager();
    const scheduler = makeScheduler(stubPlanner({
      status: "planning_failed",
      reason: { code: "invalid_dag", issues: [{ code: "cyclic_dependency", message: "cycle" }] },
    }), manager);

    const events: string[] = [];
    scheduler.subscribe((event) => events.push(event.type));

    const run = scheduler.createRun({ goal: "x", workspace: "C:/ws/project" });
    await scheduler.startRun(run.runId);

    const result = await scheduler.waitForRun(run.runId);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "planning_invalid_dag");
    assert.ok(events.includes("run.planning_failed"));
    assert.equal(manager.calls.length, 0);
  });

  it("cancels running and pending tasks when the Run is cancelled", async () => {
    const dag: TaskDAG = {
      goal: "x",
      tasks: [
        task({ id: "a", writePaths: ["a"] }),
        task({ id: "b", writePaths: ["b"] }),
        task({ id: "c", dependsOn: ["a", "b"], writePaths: [] }),
      ],
    };
    const manager = new FakeManager();
    const scheduler = makeScheduler(stubPlanner(planned(dag)), manager);

    const run = scheduler.createRun({ goal: dag.goal, workspace: "C:/ws/project" });
    await scheduler.startRun(run.runId);

    await waitFor(() => manager.calls.length >= 2);
    await scheduler.cancelRun(run.runId);

    const result = await scheduler.waitForRun(run.runId);
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.tasks.map((t) => [t.taskId, t.status]), [
      ["a", "cancelled"],
      ["b", "cancelled"],
      ["c", "cancelled"],
    ]);
    // Running agents were aborted through the manager.
    assert.equal(manager.cancelledAgents.length, 2);
  });

  it("respects the maxParallel bound", async () => {
    const dag: TaskDAG = {
      goal: "x",
      tasks: [
        task({ id: "a", writePaths: ["a"] }),
        task({ id: "b", writePaths: ["b"] }),
        task({ id: "c", writePaths: ["c"] }),
      ],
    };
    const manager = new FakeManager();
    const scheduler = makeScheduler(stubPlanner(planned(dag)), manager);

    const run = scheduler.createRun({ goal: dag.goal, workspace: "C:/ws/project", maxParallel: 1 });
    await scheduler.startRun(run.runId);

    await waitFor(() => manager.calls.length >= 1);
    assert.equal(manager.calls.length, 1);
    manager.calls[0]!.resolve(successResult(manager.calls[0]!.task.id));

    await waitFor(() => manager.calls.length >= 2);
    assert.equal(manager.calls.length, 2);
    manager.calls[1]!.resolve(successResult(manager.calls[1]!.task.id));

    await waitFor(() => manager.calls.length >= 3);
    manager.calls[2]!.resolve(successResult(manager.calls[2]!.task.id));

    const result = await scheduler.waitForRun(run.runId);
    assert.equal(result.status, "succeeded");
    assert.equal(manager.calls.length, 3);
  });

  it("emits a full run/task event sequence", async () => {
    const dag: TaskDAG = {
      goal: "x",
      tasks: [task({ id: "a", writePaths: ["a"] })],
    };
    const manager = new FakeManager();
    const scheduler = makeScheduler(stubPlanner(planned(dag)), manager);

    const events: string[] = [];
    scheduler.subscribe((event) => events.push(event.type));

    const run = scheduler.createRun({ goal: dag.goal, workspace: "C:/ws/project" });
    await scheduler.startRun(run.runId);
    await waitFor(() => manager.calls.length >= 1);
    manager.calls[0]!.resolve(successResult(manager.calls[0]!.task.id));
    await scheduler.waitForRun(run.runId);

    assert.deepEqual(events, [
      "run.created",
      "run.planning_started",
      "run.ready",
      "run.started",
      "task.ready",
      "task.running",
      "task.succeeded",
      "run.succeeded",
    ]);
  });
});
