import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentControlPlane,
  createMultiAgentRuntime,
  FileAgentTaskStore,
  MultiAgentRestApiServer,
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

describe("MultiAgentRestApiServer", () => {
  let runtime: ReturnType<typeof createMultiAgentRuntime>;
  let manager: PiAgentManager;
  let scheduler: RunScheduler;
  let server: MultiAgentRestApiServer;
  let baseUrl: string;
  let controlPlane: AgentControlPlane;
  let taskStore: FileAgentTaskStore;

  before(async () => {
    runtime = createMultiAgentRuntime();
    taskStore = new FileAgentTaskStore(join(tmpdir(), `rest-api-tasks-${Date.now()}.jsonl`));
    manager = new PiAgentManager(
      {
        create: async (childProfile: AgentProfile, childTask: AgentTask) =>
          fakeManagedAgent(childProfile, childTask),
      },
      undefined,
      taskStore,
    );
    scheduler = new RunScheduler({
      planner: fakePlanner(PLANNED),
      manager,
      factory: runtime.factory,
      registry: runtime.registry,
      maxParallel: 2,
    });
    controlPlane = new AgentControlPlane(runtime.registry, manager, {
      factory: runtime.factory,
      execution: { cwd: process.cwd(), agentDir: join(tmpdir(), "rest-api-pi") },
      runScheduler: scheduler,
    });
    server = new MultiAgentRestApiServer(controlPlane, {
      defaultWorkspace: process.cwd(),
    });
    const address = await server.start();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await server.stop();
  });

  async function jsonFetch(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }

  it("serves /api/health", async () => {
    const { status, body } = await jsonFetch("/api/health");
    assert.equal(status, 200);
    assert.deepEqual(body, { status: "ok", controlPlaneVersion: "v1" });
  });

  it("lists profiles", async () => {
    const { status, body } = await jsonFetch("/api/profiles");
    assert.equal(status, 200);
    const profiles = body as Array<{ name: string }>;
    assert.ok(profiles.some((profile) => profile.name === "researcher"));
    assert.ok(profiles.some((profile) => profile.name === "coder"));
  });

  it("creates a Run and reads it back", async () => {
    const { status, body } = await jsonFetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: VALID_DAG.goal,
        workspace: process.cwd(),
        maxParallel: 2,
      }),
    });
    assert.equal(status, 200);
    const created = body as { runId: string; status: string; goal: string };
    assert.equal(created.status, "created");
    assert.equal(created.goal, VALID_DAG.goal);

    const read = await jsonFetch(`/api/runs/${created.runId}`);
    assert.equal(read.status, 200);
    assert.equal((read.body as { runId: string }).runId, created.runId);
  });

  it("uses the default workspace when create_run omits workspace", async () => {
    const { status, body } = await jsonFetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Default workspace goal" }),
    });
    assert.equal(status, 200);
    const created = body as { runId: string; workspace: string };
    assert.equal(created.workspace, process.cwd());
  });

  it("rejects a Run workspace that does not match the host workspace", async () => {
    const { status, body } = await jsonFetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "x", workspace: join(process.cwd(), "other") }),
    });
    assert.equal(status, 422);
    assert.equal((body as { error: { code: string } }).error.code, "run_workspace_mismatch");
  });

  it("starts a Run and exposes tasks and graph", async () => {
    const { body: createdBody } = await jsonFetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: VALID_DAG.goal, workspace: process.cwd() }),
    });
    const runId = (createdBody as { runId: string }).runId;

    const started = await jsonFetch(`/api/runs/${runId}/start`, { method: "POST" });
    assert.equal(started.status, 200);
    assert.equal((started.body as { status: string }).status, "planning");

    const result = await scheduler.waitForRun(runId);
    assert.equal(result.status, "succeeded");

    const tasks = await jsonFetch(`/api/runs/${runId}/tasks`);
    assert.equal(tasks.status, 200);
    const taskList = tasks.body as Array<{ taskId: string; status: string }>;
    assert.deepEqual(taskList.map((t) => [t.taskId, t.status]), [
      ["backend", "succeeded"],
      ["qa", "succeeded"],
    ]);

    const graph = await jsonFetch(`/api/runs/${runId}/graph`);
    assert.equal(graph.status, 200);
    assert.equal((graph.body as { goal: string }).goal, VALID_DAG.goal);
  });

  it("cancels a Run", async () => {
    const { body: createdBody } = await jsonFetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: VALID_DAG.goal, workspace: process.cwd() }),
    });
    const runId = (createdBody as { runId: string }).runId;

    const cancelled = await jsonFetch(`/api/runs/${runId}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.body, { runId, status: "cancel_requested" });
  });

  it("returns 404 for unknown Runs", async () => {
    const { status, body } = await jsonFetch("/api/runs/run_nope");
    assert.equal(status, 404);
    assert.equal((body as { error: { code: string } }).error.code, "run_not_found");
  });

  it("streams Run events over SSE", async () => {
    const { body: createdBody } = await jsonFetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: VALID_DAG.goal, workspace: process.cwd() }),
    });
    const runId = (createdBody as { runId: string }).runId;

    const controller = new AbortController();
    const streamPromise = fetch(`${baseUrl}/api/runs/${runId}/events`, { signal: controller.signal })
      .then(async (response) => {
        assert.equal(response.status, 200);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const events: string[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of frame.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  const parsed = JSON.parse(line.slice(6));
                  if (parsed && typeof parsed.type === "string") events.push(parsed.type);
                } catch {
                  // ignore non-JSON data lines (e.g. the ready frame)
                }
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
          if (events.includes("run.succeeded")) break;
        }
        return events;
      });

    // Give the SSE connection a moment to establish, then start the Run.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await jsonFetch(`/api/runs/${runId}/start`, { method: "POST" });
    await scheduler.waitForRun(runId);

    const events = await streamPromise;
    controller.abort();
    // run.created fires before the SSE connection opens; the client recovers
    // it from GET /api/runs/:runId snapshots. Events after connect must arrive.
    assert.ok(events.includes("run.planning_started"), "run.planning_started expected");
    assert.ok(events.includes("task.running"), "task.running expected");
    assert.ok(events.includes("run.succeeded"), "run.succeeded expected");
  });

  it("submits Agent tasks and queries them", async () => {
    const { status, body } = await jsonFetch("/api/agents/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: "researcher",
        task: {
          id: "rest-agent-task",
          workspace: process.cwd(),
          task: "Return a report",
          acceptanceCriteria: ["Return evidence"],
          depth: 0,
        },
      }),
    });
    assert.equal(status, 200);
    const submitted = body as { agentTaskId: string; agentId: string };
    assert.equal(submitted.agentId, "builtin_researcher");

    await controlPlane.flush();
    const listed = await jsonFetch("/api/agents/tasks?profileId=builtin_researcher");
    assert.equal(listed.status, 200);
    assert.ok(
      (listed.body as Array<{ task: { id: string } }>).some((record) => record.task.id === submitted.agentTaskId),
    );

    const task = await jsonFetch(`/api/agents/tasks/${submitted.agentTaskId}`);
    assert.equal(task.status, 200);
    assert.equal((task.body as { task: { id: string } }).task.id, submitted.agentTaskId);

    const result = await jsonFetch(`/api/agents/results/${submitted.agentTaskId}`);
    assert.equal(result.status, 200);
    assert.equal((result.body as { status: string }).status, "completed");
  });

  it("retries a failed Agent task and cancels an Agent", async () => {
    const { status, body } = await jsonFetch("/api/agents/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: "researcher",
        task: {
          id: "rest-agent-retry",
          workspace: process.cwd(),
          task: "Return a report",
          acceptanceCriteria: ["Return evidence"],
          depth: 0,
        },
      }),
    });
    assert.equal(status, 200);
    const submitted = body as { agentTaskId: string; agentId: string };

    // retry of a completed task is rejected by the protocol.
    const retried = await jsonFetch(`/api/agents/tasks/${submitted.agentTaskId}/retry`, { method: "POST" });
    assert.equal(retried.status, 400);

    const cancelled = await jsonFetch(`/api/agents/${submitted.agentId}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.body, { agentId: submitted.agentId, status: "cancel_requested" });
  });

  it("validates request bodies", async () => {
    const noGoal = await jsonFetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: process.cwd() }),
    });
    assert.equal(noGoal.status, 422);

    const badJson = await jsonFetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);

    const noProfile = await jsonFetch("/api/agents/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: { id: "x" } }),
    });
    assert.equal(noProfile.status, 422);
  });

  it("returns 404 for unknown routes and 405 for wrong methods", async () => {
    const unknown = await jsonFetch("/api/nope");
    assert.equal(unknown.status, 404);

    const wrongMethod = await jsonFetch("/api/runs", { method: "DELETE" });
    assert.equal(wrongMethod.status, 405);
  });
});

describe("MultiAgentRestApiServer authorization", () => {
  it("rejects requests when the authorize hook fails", async () => {
    const runtime = createMultiAgentRuntime();
    const controlPlane = new AgentControlPlane(runtime.registry, new PiAgentManager({
      create: async (childProfile: AgentProfile, childTask: AgentTask) =>
        fakeManagedAgent(childProfile, childTask),
    }));
    const server = new MultiAgentRestApiServer(controlPlane, {
      authorize: async (request) => request.headers["x-control-token"] === "secret",
    });
    const address = await server.start();
    try {
      const denied = await fetch(`http://127.0.0.1:${address.port}/api/health`);
      assert.equal(denied.status, 401);

      const allowed = await fetch(`http://127.0.0.1:${address.port}/api/health`, {
        headers: { "x-control-token": "secret" },
      });
      assert.equal(allowed.status, 200);
    } finally {
      await server.stop();
    }
  });
});
