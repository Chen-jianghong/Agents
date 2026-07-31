import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createMultiAgentRuntime, PiSessionFactory } from "../src/index.js";
import { PlannerService } from "../src/planner.js";
import type { TaskDAG } from "../src/plan-contracts.js";

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

const CYCLIC_DAG = {
  goal: "x",
  tasks: [
    { id: "a", title: "A", role: "backend", dependsOn: ["b"], writePaths: ["a"], acceptanceCriteria: ["a"] },
    { id: "b", title: "B", role: "backend", dependsOn: ["a"], writePaths: ["b"], acceptanceCriteria: ["b"] },
  ],
};

async function fauxRuntime(providerName: string) {
  const faux = fauxProvider({
    provider: providerName,
    models: [{ id: "faux-model", reasoning: false }],
  });
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const aliases = {
    "coding-strong": `${providerName}/faux-model`,
    "coding-balanced": `${providerName}/faux-model`,
  };
  return { faux, modelRuntime, aliases };
}

describe("Phase B integration (real Pi loop with faux provider)", () => {
  it("plans a goal into a TaskDAG through a real Pi Planner session", async () => {
    const { faux, modelRuntime, aliases } = await fauxRuntime("faux-plan");
    const agentDir = join(tmpdir(), "phase-b-plan");
    try {
      faux.setResponses([fauxAssistantMessage(JSON.stringify(VALID_DAG))]);

      const planner = new PlannerService(new PiSessionFactory(), {
        cwd: process.cwd(),
        agentDir,
        modelRuntime,
        modelAliases: aliases,
      });
      const outcome = await planner.plan("Implement members management");

      assert.equal(outcome.status, "planned");
      if (outcome.status !== "planned") return;
      assert.equal(outcome.dag.tasks.length, 2);
      assert.equal(outcome.validation.valid, true);
      assert.equal(faux.state.callCount, 1);
    } finally {
      // faux providers are test-local; no unregister API.
    }
  });

  it("fails planning when the Planner output is an invalid DAG", async () => {
    const { faux, modelRuntime, aliases } = await fauxRuntime("faux-plan-bad");
    const agentDir = join(tmpdir(), "phase-b-plan-bad");
    try {
      faux.setResponses([fauxAssistantMessage(JSON.stringify(CYCLIC_DAG))]);

      const planner = new PlannerService(new PiSessionFactory(), {
        cwd: process.cwd(),
        agentDir,
        modelRuntime,
        modelAliases: aliases,
      });
      const outcome = await planner.plan("Implement something cyclic");

      assert.equal(outcome.status, "planning_failed");
      if (outcome.status !== "planning_failed") return;
      assert.equal(outcome.reason.code, "invalid_dag");
    } finally {
      // faux providers are test-local; no unregister API.
    }
  });

  it("runs a planned DAG end to end with the real Manager and Planner", async () => {
    const { faux, modelRuntime, aliases } = await fauxRuntime("faux-e2e-b");
    const root = await mkdtemp(join(tmpdir(), "phase-b-e2e-"));
    try {
      // Serial responses: planner DAG, then backend task, then qa task.
      faux.setResponses([
        fauxAssistantMessage(JSON.stringify(VALID_DAG)),
        fauxAssistantMessage("Backend task completed: members API implemented."),
        fauxAssistantMessage("QA verification passed: members tests are green."),
      ]);

      const runtime = createMultiAgentRuntime({ modelRuntime, modelAliases: aliases });
      const scheduler = runtime.createRunScheduler({
        workspace: process.cwd(),
        agentDir: join(root, "pi"),
        maxParallel: 1,
      });

      const events: string[] = [];
      scheduler.subscribe((event) => events.push(event.type));

      const run = scheduler.createRun({
        goal: VALID_DAG.goal,
        workspace: process.cwd(),
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
      assert.ok(events.includes("run.planning_started"), "planner ran");
      assert.ok(events.includes("run.ready"), "DAG accepted");
      assert.ok(events.includes("task.succeeded"), "tasks executed");
      assert.ok(events.includes("run.succeeded"), "run finalized");
      assert.equal(faux.state.callCount, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
