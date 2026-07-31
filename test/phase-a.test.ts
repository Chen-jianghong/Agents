import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { WebSocket as NodeWebSocket, type RawData } from "ws";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AgentFactory,
  AgentControlPlane,
  DEFAULT_FACTORY_POLICY,
  FileProfileStore,
  InMemoryProfileRegistry,
  LayeredProfileRegistry,
  FileAgentEventStore,
  FileAgentTaskStore,
  CONTROL_PLANE_VERSION,
  ControlPlaneWebSocketServer,
  ControlPlaneWorkerRpcClient,
  ControlPlaneWorkerRpcServer,
  WorkerProcessError,
  GitWorktreeProvider,
  WorkspaceIsolationError,
  ModelGateway,
  ModelGatewayConfigurationError,
  AgentRetryError,
  PiAgentManager,
  PiSessionFactory,
  ProfileConflictError,
  ProfileValidationError,
  authorizeTool,
  createMainAgentProfile,
  createOrchestrationTools,
  createBuiltInProfiles,
  createMultiAgentRuntime,
  createMultiAgentRuntimeAsync,
  ProfilePersistenceError,
  PersistentProfileService,
  validateProfile,
  isPathInside,
  type AgentProfile,
  type AgentEvent,
  type AgentSessionFactory,
  type AgentTask,
  type AgentWorkspaceProvider,
  type CreateAgentRequest,
  type ManagedAgent,
} from "../src/index.js";

const execFile = promisify(execFileCallback);

const task: AgentTask = {
  id: "task-1",
  workspace: "C:/workspace/project",
  task: "Inspect the project",
  acceptanceCriteria: ["return evidence"],
  writePaths: ["src"],
  depth: 0,
};

function request(overrides: Partial<CreateAgentRequest> = {}): CreateAgentRequest {
  return {
    name: "researcher",
    description: "Inspect code and report evidence",
    responsibilities: ["Read code", "Explain findings"],
    requestedTools: ["read", "grep", "find", "ls"],
    readOnly: true,
    persistence: "ephemeral",
    scope: "task",
    reason: "Need a focused code investigation",
    createdBy: "main-agent",
    ...overrides,
  };
}

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-1",
    name: "researcher",
    version: 1,
    description: "Research",
    kind: "subagent",
    identity: {
      responsibilities: ["Read"],
      nonResponsibilities: ["Write"],
      systemPrompt: "You are a researcher.",
    },
    execution: {
      model: "coding-balanced",
      thinkingLevel: "medium",
      tools: ["read", "grep", "find", "ls"],
      readOnly: true,
      writePaths: [],
      canDelegate: false,
      maxDepth: 1,
    },
    output: {
      format: "text",
      requiredSections: [],
      requiredFields: [],
      acceptanceCriteriaRequired: true,
      reportChangedFiles: false,
      reportTests: true,
      reportRisks: true,
    },
    limits: {
      maxTurns: 20,
      timeoutSeconds: 60,
      maxConcurrentChildren: 0,
    },
    context: {
      includeParentSummary: true,
      includeTaskFiles: [],
      loadProjectInstructions: true,
      memoryMode: "read",
    },
    lifecycle: {
      persistence: "ephemeral",
      scope: "task",
      createdBy: "system",
      createdAt: "2026-07-30T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("Phase A agent runtime", () => {
  it("creates a read-only profile with only read tools", () => {
    const registry = new InMemoryProfileRegistry();
    const factory = new AgentFactory(registry, DEFAULT_FACTORY_POLICY, () => "2026-07-30T00:00:00.000Z");
    const result = factory.createProfile(
      request({ requestedTools: ["read", "write", "edit", "bash"] }),
      task,
    );

    assert.deepEqual(result.profile.execution.tools, ["read"]);
    assert.match(result.warnings.join("\n"), /mutation tools/);
    assert.equal(result.profile.execution.readOnly, true);
  });

  it("requires explicit policy approval for persistent profiles", () => {
    const registry = new InMemoryProfileRegistry();
    const factory = new AgentFactory(registry);

    assert.throws(
      () => factory.createProfile(request({ persistence: "persistent", scope: "project" }), task),
      /persistent profiles require explicit user approval/,
    );
  });

  it("rejects invalid names before registration", () => {
    const registry = new InMemoryProfileRegistry();
    const factory = new AgentFactory(registry);

    assert.throws(
      () => factory.createProfile(request({ name: "React Reviewer" }), task),
      ProfileValidationError,
    );
  });

  it("prevents duplicate profiles in the same scope", () => {
    const registry = new InMemoryProfileRegistry();
    registry.register(profile());

    assert.throws(
      () => registry.register(profile({ id: "agent-2" })),
      ProfileConflictError,
    );
  });

  it("does not allow a read-only profile to mutate or delegate", () => {
    const readOnlyProfile = profile();
    const context = { workspace: "C:/workspace/project", profile: readOnlyProfile };

    assert.deepEqual(authorizeTool(context, "write", { path: "src/a.ts" }), {
      allowed: false,
      reason: "tool_not_granted",
    });
    assert.deepEqual(authorizeTool(context, "delegate", {}), {
      allowed: false,
      reason: "tool_not_granted",
    });
  });

  it("recognizes workspace boundaries", () => {
    assert.equal(isPathInside("C:/workspace/project", "src/a.ts"), true);
    assert.equal(isPathInside("C:/workspace/project", "../secrets.txt"), false);
  });

  it("keeps writable profiles inside the task write boundary", () => {
    const registry = new InMemoryProfileRegistry();
    const factory = new AgentFactory(registry, DEFAULT_FACTORY_POLICY, () => "2026-07-30T00:00:00.000Z");
    const result = factory.createProfile(
      request({
        name: "coder",
        description: "Implement the approved task",
        requestedTools: ["read", "write", "edit", "bash"],
        readOnly: false,
        requestedWritePaths: ["src"],
      }),
      { ...task, writePaths: ["src"] },
    );

    assert.deepEqual(result.profile.execution.writePaths, ["src"]);
    const context = { workspace: task.workspace, profile: result.profile };
    assert.equal(authorizeTool(context, "write", { path: "src/file.ts" }).allowed, true);
    assert.deepEqual(authorizeTool(context, "write", { path: "tests/file.ts" }), {
      allowed: false,
      reason: "path_outside_profile_boundary",
    });
  });

  it("narrows a reusable writable profile to the current task boundary", () => {
    const registry = new InMemoryProfileRegistry();
    const factory = new AgentFactory(registry, DEFAULT_FACTORY_POLICY, () => "2026-07-30T00:00:00.000Z");
    const reusableCoder = profile({
      name: "coder",
      id: "agent-coder",
      execution: {
        ...profile().execution,
        tools: ["read", "write", "edit", "bash"],
        readOnly: false,
        writePaths: ["."],
      },
    });
    const bound = factory.bindProfile(reusableCoder, { ...task, writePaths: ["src"] });

    assert.deepEqual(bound.profile.execution.writePaths, ["src"]);
    assert.equal(authorizeTool({ workspace: task.workspace, profile: bound.profile }, "write", { path: "src/a.ts" }).allowed, true);
    assert.equal(authorizeTool({ workspace: task.workspace, profile: bound.profile }, "write", { path: "tests/a.ts" }).allowed, false);
  });

  it("exposes orchestration tools only on the main Agent surface", () => {
    const registry = new InMemoryProfileRegistry();
    const factory = new AgentFactory(registry);
    const manager = new PiAgentManager(new PiSessionFactory());
    const tools = createOrchestrationTools(factory, registry, manager, {
      workspace: "C:/workspace/project",
      agentDir: "C:/workspace/.pi",
      depth: 0,
    });

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["create_agent", "delegate", "spawn_agent", "list_agents", "get_agent_result", "cancel_agent"],
    );
    assert.equal(createMainAgentProfile().kind, "main");
    assert.equal(createMainAgentProfile().execution.readOnly, true);
  });

  it("lets the main Agent create a temporary profile through the tool handler", async () => {
    const registry = new InMemoryProfileRegistry();
    const factory = new AgentFactory(registry);
    const manager = new PiAgentManager(new PiSessionFactory());
    const createTool = createOrchestrationTools(factory, registry, manager, {
      workspace: "C:/workspace/project",
      agentDir: "C:/workspace/.pi",
      depth: 0,
    })[0]!;

    const result = await createTool.execute("call-create", {
      name: "api-researcher",
      description: "Investigate the API layer",
      responsibilities: ["Trace API calls", "Report evidence"],
      requestedTools: ["read", "grep"],
      readOnly: true,
      reason: "The main task needs API-specific research",
    }, undefined, undefined, undefined as never);

    const details = result.details as { agentId: string; status: string; effectiveProfile: { readOnly: boolean } };
    assert.equal(details.status, "created");
    assert.equal(details.effectiveProfile.readOnly, true);
    assert.equal(registry.get(details.agentId).name, "api-researcher");
  });

  it("bootstraps the built-in profiles and shared runtime services", () => {
    const runtime = createMultiAgentRuntime({ now: () => "2026-07-30T00:00:00.000Z" });
    assert.deepEqual(
      runtime.registry.list().map((item) => item.name),
      ["researcher", "coder", "tester", "reviewer"],
    );
    assert.equal(runtime.registry.get("coder").execution.writePaths[0], ".");
    assert.equal(runtime.defaultModel, "coding-balanced");
    assert.equal(createBuiltInProfiles("2026-07-30T00:00:00.000Z").length, 4);
  });

  it("creates the main Agent as a real Pi Session with orchestration tools", async () => {
    const runtime = createMultiAgentRuntime({ now: () => "2026-07-30T00:00:00.000Z" });
    const agent = await runtime.createMainAgent({
      cwd: process.cwd(),
      workspace: process.cwd(),
      agentDir: join(tmpdir(), "multi-agent-dev-phase-a-test"),
    });

    assert.equal(agent.profile.kind, "main");
    assert.ok(agent.sessionId.length > 0);
    assert.deepEqual(agent.profile.execution.tools, [
      "read",
      "grep",
      "find",
      "ls",
      "create_agent",
      "spawn_agent",
      "delegate",
      "list_agents",
      "get_agent_result",
      "cancel_agent",
    ]);
    await agent.cancel();
  });

  it("enforces the profile path boundary through Pi's beforeToolCall hook", async () => {
    const workspace = process.cwd();
    const registry = new InMemoryProfileRegistry();
    const factory = new AgentFactory(registry, DEFAULT_FACTORY_POLICY, () => "2026-07-30T00:00:00.000Z");
    const created = factory.createProfile(
      request({
        name: "guarded-coder",
        description: "Write only inside src",
        requestedTools: ["read", "write", "edit"],
        readOnly: false,
        requestedWritePaths: ["src"],
      }),
      { ...task, workspace, writePaths: ["src"] },
    );
    const session = await new PiSessionFactory().create(created.profile, { ...task, workspace, writePaths: ["src"] }, {
      cwd: workspace,
      agentDir: join(tmpdir(), "multi-agent-dev-hook-test"),
    });

    const hook = session.session.agent.beforeToolCall;
    assert.ok(hook);
    const blocked = await hook({
      assistantMessage: {} as never,
      toolCall: { id: "call-1", name: "write", arguments: "{}" } as never,
      args: { path: "outside.txt", content: "blocked" },
      context: {} as never,
    });
    const allowed = await hook({
      assistantMessage: {} as never,
      toolCall: { id: "call-2", name: "write", arguments: "{}" } as never,
      args: { path: "src/inside.ts", content: "allowed" },
      context: {} as never,
    });

    assert.deepEqual(blocked, { block: true, reason: "path_outside_profile_boundary" });
    assert.equal(allowed, undefined);
    await session.cancel();
  });

  it("forwards Pi session events through the Manager boundary", async () => {
    const runtime = createMultiAgentRuntime();
    const events: string[] = [];
    const unsubscribe = runtime.manager.subscribe((event) => events.push(event.type));
    const profile = runtime.registry.get("researcher");
    const result = await runtime.manager.run(
      profile,
      {
        id: "event-task",
        workspace: process.cwd(),
        task: "event smoke task",
        acceptanceCriteria: [],
        depth: 0,
      },
      {
        cwd: process.cwd(),
        agentDir: join(tmpdir(), "multi-agent-dev-event-test"),
      },
    );
    unsubscribe();

    assert.equal(result.status, "failed");
    assert.ok(events.length > 0);
    assert.ok(events.includes("agent_manager_started"));
    assert.ok(events.includes("agent_manager_failed"));
  });

  it("persists normalized Agent events and redacts sensitive payload fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-events-"));
    try {
      const store = new FileAgentEventStore(join(root, "events.jsonl"));
      const redactionEvent: AgentEvent = {
        eventId: "redaction-event",
        agentId: "agent-test",
        agentTaskId: "redaction-task",
        type: "test",
        sequence: 1,
        timestamp: "2026-07-31T00:00:00.000Z",
        payload: {
          apiKey: "event-secret",
          nested: { authorization: "Bearer event-secret", result: "kept" },
        },
      };
      await Promise.all([store.append(redactionEvent), store.append({
        ...redactionEvent,
        eventId: "second-event",
        sequence: 2,
      })]);

      const raw = await readFile(join(root, "events.jsonl"), "utf8");
      assert.equal(raw.includes("event-secret"), false);
      const redacted = (await store.list({ agentTaskId: "redaction-task" }))[0]!;
      assert.equal((redacted.payload as { apiKey: string }).apiKey, "[REDACTED]");
      assert.equal(
        ((redacted.payload as { nested: { authorization: string; result: string } }).nested).authorization,
        "[REDACTED]",
      );
      assert.equal(
        ((redacted.payload as { nested: { authorization: string; result: string } }).nested).result,
        "kept",
      );

      const runtime = createMultiAgentRuntime({ eventStore: store });
      const result = await runtime.manager.run(
        runtime.registry.get("researcher"),
        {
          id: "persisted-event-task",
          workspace: process.cwd(),
          task: "event persistence smoke task",
          acceptanceCriteria: [],
          depth: 0,
        },
        {
          cwd: process.cwd(),
          agentDir: join(root, ".pi"),
        },
      );
      await runtime.manager.flushEvents();
      assert.equal(result.status, "failed");
      const taskEvents = await store.list({ agentTaskId: "persisted-event-task" });
      assert.ok(taskEvents.some((event) => event.type === "agent_manager_started"));
      assert.ok(taskEvents.some((event) => event.type === "agent_manager_failed"));
      assert.ok(taskEvents.some((event) => event.type.startsWith("agent_")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists task lifecycle records and recovers results in a fresh Manager", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-task-store-"));
    try {
      const taskStore = new FileAgentTaskStore(join(root, "tasks.json"));
      const runtime = createMultiAgentRuntime({ taskStore });
      const persistedTask: AgentTask = {
        id: "recoverable-task",
        workspace: process.cwd(),
        task: "task recovery smoke task",
        acceptanceCriteria: [],
        depth: 0,
      };
      const result = await runtime.manager.run(
        runtime.registry.get("researcher"),
        persistedTask,
        {
          cwd: process.cwd(),
          agentDir: join(root, ".pi"),
        },
      );
      await runtime.manager.flushTasks();

      assert.equal(result.status, "failed");
      const record = await taskStore.get(persistedTask.id);
      assert.ok(record);
      assert.equal(record.status, "failed");
      assert.equal(record.profileId, "builtin_researcher");
      assert.equal(record.profileVersion, 1);
      assert.equal(record.result?.error?.code, result.error?.code);

      const freshManager = new PiAgentManager(new PiSessionFactory(), undefined, taskStore);
      assert.deepEqual(await freshManager.getResult(persistedTask.id), result);
      assert.equal((await freshManager.getTask(persistedTask.id))?.status, "failed");
      assert.equal((await taskStore.list({ status: "failed" })).length, 1);

      const profilesResponse = await runtime.controlPlane.handle({
        version: CONTROL_PLANE_VERSION,
        requestId: "profiles-1",
        type: "list_profiles",
      });
      assert.equal(profilesResponse.ok, true);
      if (profilesResponse.ok && Array.isArray(profilesResponse.data)) {
        assert.equal(profilesResponse.data.length, 4);
      }

      const tasksResponse = await runtime.controlPlane.handle({
        version: CONTROL_PLANE_VERSION,
        requestId: "tasks-1",
        type: "list_tasks",
        filter: { status: "failed" },
      });
      assert.equal(tasksResponse.ok, true);
      if (tasksResponse.ok && Array.isArray(tasksResponse.data)) {
        assert.equal((tasksResponse.data[0] as { task: AgentTask } | undefined)?.task.id, persistedTask.id);
      }

      const resultResponse = await runtime.controlPlane.handle({
        version: CONTROL_PLANE_VERSION,
        requestId: "result-1",
        type: "get_result",
        agentTaskId: persistedTask.id,
      });
      assert.equal(resultResponse.ok, true);
      if (resultResponse.ok) assert.deepEqual(resultResponse.data, result);

      const versionError = await runtime.controlPlane.handle({
        version: "v2",
        requestId: "bad-version",
        type: "list_profiles",
      });
      assert.equal(versionError.ok, false);
      if (!versionError.ok) assert.equal(versionError.error.code, "unsupported_version");

      const commandError = await runtime.controlPlane.handle({
        version: CONTROL_PLANE_VERSION,
        requestId: "bad-command",
        type: "unknown_command",
      });
      assert.equal(commandError.ok, false);
      if (!commandError.ok) assert.equal(commandError.error.code, "unknown_command");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries a persisted task in a fresh Manager from snapshots and host dependencies", async () => {
    let createCount = 0;
    let recoveredProfileVersion = 0;
    let recoveredModelRuntime: unknown;
    let recoveredModelAliases: unknown;
    const sessionFactory: AgentSessionFactory = {
      create: async (childProfile, childTask, sessionOptions) => {
        createCount += 1;
        const attempt = createCount;
        if (attempt === 2) {
          recoveredProfileVersion = childProfile.version;
          recoveredModelRuntime = sessionOptions.modelRuntime;
          recoveredModelAliases = sessionOptions.modelAliases;
        }
        return {
          agentId: childProfile.id,
          sessionId: `snapshot-retry-session-${attempt}`,
          profile: childProfile,
          session: {} as never,
          status: "created" as const,
          prompt: async () => ({
            agentId: childProfile.id,
            agentTaskId: childTask.id,
            status: attempt === 1 ? "failed" as const : "completed" as const,
            changedFiles: [],
            tests: [],
            risks: [],
            ...(attempt === 1
              ? { error: { code: "transient", message: "temporary failure" } }
              : {}),
          }),
          cancel: async () => undefined,
          subscribe: () => () => undefined,
        };
      },
    };
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-recovery-"));
    try {
      const taskPath = join(root, "tasks.json");
      const taskStore = new FileAgentTaskStore(taskPath);
      const persistedProfile = profile({ id: "snapshot-agent", name: "snapshot-agent", version: 1 });
      const workspaceProvider: AgentWorkspaceProvider = {
        acquire: async (_profile, taskToRun, workspaceOptions) => ({
          sourceWorkspace: taskToRun.workspace,
          cwd: workspaceOptions.cwd,
          agentDir: workspaceOptions.agentDir,
          release: async () => undefined,
        }),
      };
      const execution = {
        cwd: process.cwd(),
        agentDir: join(root, ".pi"),
        parentAgentId: "main-agent",
        maxConcurrentChildren: 4,
        workspaceProvider,
        modelRuntime: { secret: "initial-runtime-secret" } as never,
        modelAliases: { "coding-balanced": "host/initial-model" },
      };
      const firstManager = new PiAgentManager(sessionFactory, undefined, taskStore);
      const first = await firstManager.run(persistedProfile, { ...task, id: "snapshot-retry-task" }, execution);
      assert.equal(first.status, "failed");
      await firstManager.flushTasks();

      const persisted = await taskStore.get("snapshot-retry-task");
      assert.ok(persisted);
      assert.deepEqual(persisted.profileSnapshot, persistedProfile);
      assert.deepEqual(persisted.executionSnapshot, {
        cwd: execution.cwd,
        agentDir: execution.agentDir,
        parentAgentId: execution.parentAgentId,
        maxConcurrentChildren: execution.maxConcurrentChildren,
        workspaceProviderRequired: true,
      });
      const raw = await readFile(taskPath, "utf8");
      assert.equal(raw.includes("initial-runtime-secret"), false);
      assert.equal(raw.includes("modelRuntime"), false);
      assert.equal(raw.includes("modelAliases"), false);

      const noHostManager = new PiAgentManager(sessionFactory, undefined, taskStore);
      await assert.rejects(
        noHostManager.retry("snapshot-retry-task"),
        (error: unknown) => error instanceof AgentRetryError
          && error.code === "agent_retry_execution_unavailable",
      );

      const recoveredRuntime = { secret: "recovered-runtime-secret" } as never;
      const recoveredManager = new PiAgentManager(sessionFactory, undefined, taskStore, {
        taskRecovery: {
          resolveExecution: ({ record, profile: snapshot }) => {
            assert.equal(record.profileSnapshot?.version, 1);
            assert.equal(snapshot.version, 1);
            return {
              cwd: execution.cwd,
              agentDir: execution.agentDir,
              parentAgentId: "main-agent",
              maxConcurrentChildren: 4,
              workspaceProvider,
              modelRuntime: recoveredRuntime,
              modelAliases: { "coding-balanced": "host/recovered-model" },
            };
          },
        },
      });
      const retry = await recoveredManager.retry("snapshot-retry-task");
      assert.equal(retry.attempt, 2);
      assert.equal((await retry.promise).status, "completed");
      await recoveredManager.flushTasks();
      assert.equal(recoveredProfileVersion, 1);
      assert.equal(recoveredModelRuntime, recoveredRuntime);
      assert.deepEqual(recoveredModelAliases, { "coding-balanced": "host/recovered-model" });

      const duplicate = await recoveredManager.run(
        profile({ id: "newer-agent", name: "newer-agent", version: 2 }),
        { ...task, id: "snapshot-retry-task" },
        execution,
      );
      assert.equal(duplicate.error?.code, "agent_task_already_completed");
      const unchanged = await taskStore.get("snapshot-retry-task");
      assert.equal(unchanged?.attempt, 2);
      assert.equal(unchanged?.status, "completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a structured recovery error for legacy task records without snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-legacy-task-"));
    try {
      const taskPath = join(root, "tasks.json");
      await writeFile(taskPath, JSON.stringify({
        "legacy-task": {
          task: { ...task, id: "legacy-task" },
          profileId: "legacy-agent",
          profileVersion: 1,
          status: "failed",
          attempt: 1,
          createdAt: "2026-07-30T00:00:00.000Z",
          result: {
            agentId: "legacy-agent",
            agentTaskId: "legacy-task",
            status: "failed",
            changedFiles: [],
            tests: [],
            risks: [],
            error: { code: "legacy_failure", message: "old record" },
          },
        },
      }, null, 2) + "\n", "utf8");
      const manager = new PiAgentManager({
        create: async () => {
          throw new Error("legacy records must not guess a Profile");
        },
      }, undefined, new FileAgentTaskStore(taskPath));

      await assert.rejects(
        manager.retry("legacy-task"),
        (error: unknown) => error instanceof AgentRetryError && error.code === "agent_retry_unavailable",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("submits Control Plane tasks only through configured host execution defaults", async () => {
    const runtime = createMultiAgentRuntime();
    const manager = new PiAgentManager({
      create: async (childProfile, childTask) => fakeManagedAgent(childProfile, childTask, async () => undefined),
    });
    const execution = {
      cwd: process.cwd(),
      agentDir: join(tmpdir(), "multi-agent-dev-control-plane-run"),
    };
    const controlPlane = new AgentControlPlane(runtime.registry, manager, {
      factory: runtime.factory,
      execution,
    });
    const submitted = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "submit-1",
      type: "run_agent",
      profileId: "researcher",
      task: {
        id: "control-plane-task",
        workspace: process.cwd(),
        task: "Return a focused report",
        acceptanceCriteria: ["Return evidence"],
        depth: 0,
      },
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) throw new Error("Control Plane task submission failed");
    const submittedData = submitted.data as {
      agentId: string;
      agentTaskId: string;
      status: "running";
      warnings: string[];
    };
    assert.equal(submittedData.status, "running");
    assert.equal(submittedData.agentId, "builtin_researcher");
    assert.deepEqual(submittedData.warnings, []);

    const result = await manager.getResult(submittedData.agentTaskId);
    assert.equal(result?.status, "completed");
    const queried = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "result-1",
      type: "get_result",
      agentTaskId: submittedData.agentTaskId,
    });
    assert.equal(queried.ok, true);

    const workspaceError = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "submit-bad-workspace",
      type: "run_agent",
      profileId: "researcher",
      task: {
        id: "control-plane-bad-workspace",
        workspace: join(process.cwd(), "other-workspace"),
        task: "Should be rejected",
        acceptanceCriteria: [],
        depth: 0,
      },
    });
    assert.equal(workspaceError.ok, false);
    if (!workspaceError.ok) assert.equal(workspaceError.error.code, "task_workspace_mismatch");

    const depthError = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "submit-too-deep",
      type: "run_agent",
      profileId: "researcher",
      task: {
        id: "control-plane-too-deep",
        workspace: process.cwd(),
        task: "Should be rejected",
        acceptanceCriteria: [],
        depth: 2,
      },
    });
    assert.equal(depthError.ok, false);
    if (!depthError.ok) assert.equal(depthError.error.code, "agent_depth_limit");

    const unavailable = new AgentControlPlane(runtime.registry, manager, { factory: runtime.factory });
    const unavailableResponse = await unavailable.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "submit-unavailable",
      type: "run_agent",
      profileId: "researcher",
      task: {
        id: "control-plane-unavailable",
        workspace: process.cwd(),
        task: "Should be unavailable",
        acceptanceCriteria: [],
        depth: 0,
      },
    });
    assert.equal(unavailableResponse.ok, false);
    if (!unavailableResponse.ok) assert.equal(unavailableResponse.error.code, "task_submission_unavailable");

    const invalidTask = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "submit-invalid-task",
      type: "run_agent",
      profileId: "researcher",
      task: { id: "missing-fields" },
    });
    assert.equal(invalidTask.ok, false);
    if (!invalidTask.ok) assert.equal(invalidTask.error.code, "invalid_request");
  });

  it("serves the Control Plane over authenticated loopback HTTP and SSE", async () => {
    const runtime = createMultiAgentRuntime();
    const server = runtime.createControlPlaneHttpServer({
      authorize: (request) => request.headers["x-control-token"] === "test-token",
    });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const headers = {
      "content-type": "application/json",
      "x-control-token": "test-token",
    };

    try {
      const unauthorized = await fetch(`${baseUrl}/v1/control-plane`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: CONTROL_PLANE_VERSION,
          requestId: "unauthorized",
          type: "list_profiles",
        }),
      });
      assert.equal(unauthorized.status, 401);

      const health = await fetch(`${baseUrl}/healthz`, {
        headers: { "x-control-token": "test-token" },
      });
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), {
        status: "ok",
        controlPlaneVersion: CONTROL_PLANE_VERSION,
      });

      const profiles = await fetch(`${baseUrl}/v1/control-plane`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          version: CONTROL_PLANE_VERSION,
          requestId: "http-profiles",
          type: "list_profiles",
        }),
      });
      assert.equal(profiles.status, 200);
      const profileResponse = await profiles.json() as { ok: boolean; data?: unknown[] };
      assert.equal(profileResponse.ok, true);
      assert.equal(profileResponse.data?.length, 4);

      const invalidJson = await fetch(`${baseUrl}/v1/control-plane`, {
        method: "POST",
        headers,
        body: "{invalid",
      });
      assert.equal(invalidJson.status, 400);

      const events = await fetch(`${baseUrl}/v1/events`, {
        headers: { "x-control-token": "test-token" },
      });
      assert.equal(events.status, 200);
      assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/);
      const reader = events.body?.getReader();
      assert.ok(reader);
      const firstChunk = await reader.read();
      assert.match(Buffer.from(firstChunk.value ?? []).toString("utf8"), /event: ready/);
      await reader.cancel();
    } finally {
      await server.stop();
    }
  });

  it("serves the Control Plane over authenticated WebSocket", async () => {
    const runtime = createMultiAgentRuntime();
    const server = runtime.createControlPlaneWebSocketServer({
      authorize: (request) => request.headers["x-control-token"] === "test-token",
    });
    const address = await server.start();
    const url = `ws://${address.host}:${address.port}${address.path}`;

    try {
      const unauthorized = new NodeWebSocket(url);
      const unauthorizedStatus = await waitForUnexpectedWebSocketResponse(unauthorized);
      assert.equal(unauthorizedStatus, 401);

      const socket = new NodeWebSocket(url, {
        headers: { "x-control-token": "test-token" },
      });
      const readyMessage = nextWebSocketMessage(socket);
      await waitForWebSocketOpen(socket);
      assert.deepEqual(await readyMessage, {
        version: CONTROL_PLANE_VERSION,
        type: "ready",
      });

      socket.send(JSON.stringify({
        version: CONTROL_PLANE_VERSION,
        requestId: "ws-profiles",
        type: "list_profiles",
      }));
      const profiles = await nextWebSocketMessage(socket) as {
        ok: boolean;
        data?: unknown[];
      };
      assert.equal(profiles.ok, true);
      assert.equal(profiles.data?.length, 4);

      socket.send("{invalid");
      const invalid = await nextWebSocketMessage(socket) as {
        ok: boolean;
        error?: { code: string };
      };
      assert.equal(invalid.ok, false);
      assert.equal(invalid.error?.code, "invalid_json");
      socket.close();
      await waitForWebSocketClose(socket);
    } finally {
      await server.stop();
    }
  });

  it("pushes redacted Control Plane events over WebSocket", async () => {
    const runtime = createMultiAgentRuntime();
    const listeners = new Set<(event: AgentEvent) => void>();
    const manager = {
      subscribe(listener: (event: AgentEvent) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as PiAgentManager;
    const controlPlane = new AgentControlPlane(runtime.registry, manager);
    const server = new ControlPlaneWebSocketServer(controlPlane);
    const address = await server.start();
    const socket = new NodeWebSocket(`ws://${address.host}:${address.port}${address.path}`);

    try {
      const readyMessage = nextWebSocketMessage(socket);
      await waitForWebSocketOpen(socket);
      await readyMessage;
      const event: AgentEvent = {
        eventId: "ws-event",
        agentId: "agent-researcher",
        agentTaskId: "ws-task",
        type: "agent_completed",
        sequence: 1,
        timestamp: new Date().toISOString(),
        payload: {
          apiKey: "ws-secret",
          nested: { authorization: "Bearer ws-secret", result: "kept" },
        },
      };
      for (const listener of listeners) listener(event);

      const message = await nextWebSocketMessage(socket) as {
        type: string;
        data: AgentEvent;
      };
      assert.equal(message.type, "event");
      assert.equal((message.data.payload as { apiKey: string }).apiKey, "[REDACTED]");
      assert.equal(
        ((message.data.payload as { nested: { authorization: string } }).nested).authorization,
        "[REDACTED]",
      );
      assert.equal(
        ((message.data.payload as { nested: { result: string } }).nested).result,
        "kept",
      );
    } finally {
      socket.close();
      await waitForWebSocketClose(socket);
      await server.stop();
    }
  });

  it("enforces WebSocket message size and backpressure limits", async () => {
    const runtime = createMultiAgentRuntime();
    const messageServer = runtime.createControlPlaneWebSocketServer({ maxMessageBytes: 64 });
    const messageAddress = await messageServer.start();
    const messageSocket = new NodeWebSocket(
      `ws://${messageAddress.host}:${messageAddress.port}${messageAddress.path}`,
    );

    try {
      const readyMessage = nextWebSocketMessage(messageSocket);
      await waitForWebSocketOpen(messageSocket);
      await readyMessage;
      messageSocket.send(JSON.stringify({
        version: CONTROL_PLANE_VERSION,
        requestId: "too-large",
        type: "list_profiles",
        padding: "x".repeat(256),
      }));
      assert.equal(await waitForWebSocketClose(messageSocket), 1009);
    } finally {
      await messageServer.stop();
    }

    const backpressureServer = runtime.createControlPlaneWebSocketServer({ maxBufferedBytes: 64 });
    const backpressureAddress = await backpressureServer.start();
    const backpressureSocket = new NodeWebSocket(
      `ws://${backpressureAddress.host}:${backpressureAddress.port}${backpressureAddress.path}`,
    );
    try {
      const readyMessage = nextWebSocketMessage(backpressureSocket);
      await waitForWebSocketOpen(backpressureSocket);
      await readyMessage;
      backpressureSocket.send(JSON.stringify({
        version: CONTROL_PLANE_VERSION,
        requestId: "backpressure",
        type: "list_profiles",
      }));
      assert.equal(await waitForWebSocketClose(backpressureSocket), 1013);
    } finally {
      await backpressureServer.stop();
    }
  });

  it("serves the Control Plane through authenticated Worker RPC", async () => {
    const runtime = createMultiAgentRuntime();
    const badClientToWorker = new PassThrough();
    const badWorkerToClient = new PassThrough();
    const badServer = runtime.createControlPlaneWorkerRpcServer(
      badClientToWorker,
      badWorkerToClient,
      { authorize: (token) => token === "worker-token" },
    );
    const badClient = new ControlPlaneWorkerRpcClient(badWorkerToClient, badClientToWorker, {
      token: "wrong-token",
    });
    badServer.start();
    await assert.rejects(badClient.start(), /authorization failed|stream closed/);
    await badClient.stop();
    await badServer.stop();

    const clientToWorker = new PassThrough();
    const workerToClient = new PassThrough();
    const server = runtime.createControlPlaneWorkerRpcServer(
      clientToWorker,
      workerToClient,
      { authorize: (token) => token === "worker-token" },
    );
    const client = new ControlPlaneWorkerRpcClient(workerToClient, clientToWorker, {
      token: "worker-token",
    });
    server.start();

    try {
      await client.start();
      const response = await client.request({
        version: CONTROL_PLANE_VERSION,
        requestId: "worker-profiles",
        type: "list_profiles",
      });
      assert.equal(response.ok, true);
      if (response.ok && Array.isArray(response.data)) assert.equal(response.data.length, 4);
    } finally {
      await client.stop();
      await server.stop();
    }
  });

  it("frames Worker RPC requests across chunks and redacts pushed events", async () => {
    const runtime = createMultiAgentRuntime();
    const clientToWorker = new PassThrough();
    const workerToClient = new PassThrough();
    const output = new JsonlTestReader(workerToClient);
    const server = runtime.createControlPlaneWorkerRpcServer(clientToWorker, workerToClient);
    server.start();

    try {
      const ready = await output.next();
      assert.deepEqual(ready, {
        version: CONTROL_PLANE_VERSION,
        type: "ready",
        authenticated: true,
      });

      clientToWorker.write('{"version":"v1","requestId":"chunked","type":"list_');
      clientToWorker.write('profiles"}\n');
      const response = await output.next() as { ok: boolean; data?: unknown[] };
      assert.equal(response.ok, true);
      assert.equal(response.data?.length, 4);

      const listeners = new Set<(event: AgentEvent) => void>();
      const eventControlPlane = new AgentControlPlane(
        runtime.registry,
        { subscribe: (listener: (event: AgentEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        } } as unknown as PiAgentManager,
      );
      const eventInput = new PassThrough();
      const eventOutput = new PassThrough();
      const eventReader = new JsonlTestReader(eventOutput);
      const eventServer = new ControlPlaneWorkerRpcServer(
        eventControlPlane,
        eventInput,
        eventOutput,
      );
      eventServer.start();
      try {
        await eventReader.next();
        const event: AgentEvent = {
          eventId: "worker-event",
          agentId: "worker-agent",
          agentTaskId: "worker-task",
          type: "agent_completed",
          sequence: 1,
          timestamp: new Date().toISOString(),
          payload: { apiKey: "worker-secret", result: "kept" },
        };
        for (const listener of listeners) listener(event);
        const pushed = await eventReader.next() as { type: string; data: AgentEvent };
        assert.equal(pushed.type, "event");
        assert.equal((pushed.data.payload as { apiKey: string }).apiKey, "[REDACTED]");
        assert.equal((pushed.data.payload as { result: string }).result, "kept");
      } finally {
        await eventServer.stop();
        eventReader.close();
      }
    } finally {
      await server.stop();
      output.close();
    }
  });

  it("closes Worker RPC when a response exceeds the frame budget", async () => {
    const runtime = createMultiAgentRuntime();
    const clientToWorker = new PassThrough();
    const workerToClient = new PassThrough();
    const server = runtime.createControlPlaneWorkerRpcServer(
      clientToWorker,
      workerToClient,
      { maxFrameBytes: 64 },
    );
    const client = new ControlPlaneWorkerRpcClient(workerToClient, clientToWorker, {
      maxFrameBytes: 64,
    });
    server.start();

    try {
      await client.start();
      await assert.rejects(
        client.request({ version: CONTROL_PLANE_VERSION, requestId: "overflow", type: "list_profiles" }),
        /Worker RPC stream closed|backpressure|stopped/,
      );
    } finally {
      await client.stop();
      await server.stop();
    }
  });

  it("supervises an authenticated Worker process through Runtime", async () => {
    const runtime = createMultiAgentRuntime();
    const worker = runtime.createControlPlaneWorkerProcess({
      command: process.execPath,
      args: ["--input-type=module", "-e", workerScript("normal")],
      env: { MULTI_AGENT_WORKER_TOKEN: "worker-token" },
      token: "worker-token",
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
    });

    await worker.start();
    try {
      assert.equal(worker.running, true);
      assert.ok(worker.pid);
      const response = await worker.request({
        version: CONTROL_PLANE_VERSION,
        requestId: "supervised-worker-profiles",
        type: "list_profiles",
      });
      assert.equal(response.ok, true);
      if (response.ok && Array.isArray(response.data)) assert.equal(response.data.length, 4);
    } finally {
      await worker.stop();
    }
    assert.equal(worker.running, false);
    assert.equal(worker.pid, undefined);
  });

  it("cleans up a Worker that does not complete the RPC handshake", async () => {
    const runtime = createMultiAgentRuntime();
    const worker = runtime.createControlPlaneWorkerProcess({
      command: process.execPath,
      args: ["--input-type=module", "-e", workerScript("never-ready")],
      startupTimeoutMs: 100,
      shutdownTimeoutMs: 100,
    });

    await assert.rejects(worker.start(), WorkerProcessError);
    assert.equal(worker.running, false);
    assert.equal(worker.pid, undefined);
  });

  it("rejects pending Worker requests when the process exits unexpectedly", async () => {
    const runtime = createMultiAgentRuntime();
    const worker = runtime.createControlPlaneWorkerProcess({
      command: process.execPath,
      args: ["--input-type=module", "-e", workerScript("crash")],
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
    });

    await worker.start();
    try {
      await assert.rejects(
        worker.request({
          version: CONTROL_PLANE_VERSION,
          requestId: "crashing-worker-request",
          type: "list_profiles",
        }),
        /Worker process exited|stream closed|Worker RPC/,
      );
    } finally {
      await worker.stop();
    }
  });

  it("enforces the parent Agent concurrent-child limit", async () => {
    let active = 0;
    let maxObserved = 0;
    const sessionFactory: AgentSessionFactory = {
      create: async (childProfile, childTask) => fakeManagedAgent(childProfile, childTask, async () => {
        active += 1;
        maxObserved = Math.max(maxObserved, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
      }),
    };
    const manager = new PiAgentManager(sessionFactory);
    const options = {
      cwd: process.cwd(),
      agentDir: join(tmpdir(), "multi-agent-dev-concurrency-test"),
      parentAgentId: "agent_main",
      maxConcurrentChildren: 1,
    };

    const first = manager.run(
      profile({ id: "child-one", name: "child-one" }),
      { ...task, id: "child-task-one" },
      options,
    );
    const second = await manager.run(
      profile({ id: "child-two", name: "child-two" }),
      { ...task, id: "child-task-two" },
      options,
    );
    const firstResult = await first;

    assert.equal(firstResult.status, "completed");
    assert.equal(second.status, "failed");
    assert.equal(second.error?.code, "agent_concurrency_limit");
    assert.equal(maxObserved, 1);
  });

  it("retries failed tasks with a new attempt and protects completed results", async () => {
    let createCount = 0;
    const sessionFactory: AgentSessionFactory = {
      create: async (childProfile, childTask) => {
        createCount += 1;
        const attempt = createCount;
        return {
          agentId: childProfile.id,
          sessionId: `retry-session-${attempt}`,
          profile: childProfile,
          session: {} as never,
          status: "created" as const,
          prompt: async () => ({
            agentId: childProfile.id,
            agentTaskId: childTask.id,
            status: attempt === 1 ? "failed" as const : "completed" as const,
            changedFiles: [],
            tests: [],
            risks: [],
            ...(attempt === 1 ? { error: { code: "transient", message: "temporary failure" } } : {}),
          }),
          cancel: async () => undefined,
          subscribe: () => () => undefined,
        };
      },
    };
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-retry-"));
    try {
      const taskStore = new FileAgentTaskStore(join(root, "tasks.json"));
      const manager = new PiAgentManager(sessionFactory, undefined, taskStore);
      const retryTask = { ...task, id: "retry-task" };
      const retryProfile = profile({ id: "retry-agent", name: "retry-agent" });
      const options = {
        cwd: process.cwd(),
        agentDir: join(root, ".pi"),
      };

      const first = await manager.run(retryProfile, retryTask, options);
      assert.equal(first.status, "failed");

      const controlPlane = new AgentControlPlane(new InMemoryProfileRegistry(), manager);
      const retryResponse = await controlPlane.handle({
        version: CONTROL_PLANE_VERSION,
        requestId: "retry-request",
        type: "retry_agent",
        agentTaskId: retryTask.id,
      });
      assert.equal(retryResponse.ok, true);
      if (retryResponse.ok) {
        const data = retryResponse.data as { attempt: number; status: "queued" | "running" };
        assert.equal(data.attempt, 2);
        assert.equal(data.status, "running");
      }

      const second = await manager.getResult(retryTask.id);
      assert.equal(second?.status, "completed");
      await manager.flushTasks();
      const record = await manager.getTask(retryTask.id);
      assert.equal(record?.attempt, 2);
      assert.equal(record?.status, "completed");

      await assert.rejects(
        manager.retry(retryTask.id),
        /Completed Agent task .* cannot be retried/,
      );
      const rerun = await manager.run(retryProfile, retryTask, options);
      assert.equal(rerun.error?.code, "agent_task_already_completed");
      const unchanged = await manager.getTask(retryTask.id);
      assert.equal(unchanged?.attempt, 2);
      assert.equal(unchanged?.status, "completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("queues background Agent tasks with FIFO scheduling and cancels queued work", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-scheduler-"));
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    let active = 0;
    let maxObserved = 0;
    const startedOrder: string[] = [];
    const sessionFactory: AgentSessionFactory = {
      create: async (childProfile, childTask) => fakeManagedAgent(childProfile, childTask, async () => {
        active += 1;
        maxObserved = Math.max(maxObserved, active);
        startedOrder.push(childTask.id);
        if (childTask.id === "queue-one") {
          resolveFirstStarted();
          await firstGate;
        }
        active -= 1;
      }),
    };
    const taskStore = new FileAgentTaskStore(join(root, "tasks.json"));
    const manager = new PiAgentManager(sessionFactory, undefined, taskStore, {
      maxConcurrentTasks: 1,
    });
    const options = {
      cwd: process.cwd(),
      agentDir: join(root, ".pi"),
    };

    try {
      const first = await manager.runBackground(
        profile({ id: "queue-agent-one" }),
        { ...task, id: "queue-one" },
        options,
      );
      await firstStarted;
      const second = await manager.runBackground(
        profile({ id: "queue-agent-two" }),
        { ...task, id: "queue-two" },
        options,
      );
      const third = await manager.runBackground(
        profile({ id: "queue-agent-three" }),
        { ...task, id: "queue-three" },
        options,
      );
      assert.equal(first.status, "running");
      assert.equal(second.status, "queued");
      assert.equal(third.status, "queued");
      await manager.flushTasks();
      assert.equal((await taskStore.get("queue-two"))?.status, "queued");

      await manager.cancel("queue-agent-three");
      const cancelled = await third.promise;
      assert.equal(cancelled.status, "cancelled");
      assert.equal((await taskStore.get("queue-three"))?.status, "cancelled");

      releaseFirst();
      assert.equal((await first.promise).status, "completed");
      assert.equal((await second.promise).status, "completed");
      assert.deepEqual(startedOrder, ["queue-one", "queue-two"]);
      assert.equal(maxObserved, 1);
    } finally {
      releaseFirst();
      await manager.flushTasks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates writable Agents in Git worktrees and releases them safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-worktree-"));
    const repository = join(root, "repository");
    const worktreeRoot = join(root, "worktrees");
    await mkdir(repository, { recursive: true });
    await execFile("git", ["init", repository]);
    await execFile("git", ["-C", repository, "config", "user.email", "agent-test@example.com"]);
    await execFile("git", ["-C", repository, "config", "user.name", "Agent Test"]);
    await writeFile(join(repository, "README.md"), "initial\n", "utf8");
    await execFile("git", ["-C", repository, "add", "README.md"]);
    await execFile("git", ["-C", repository, "commit", "-m", "initial"]);

    const writableProfile = profile({
      id: "worktree-agent",
      execution: {
        ...profile().execution,
        tools: ["read", "write"],
        readOnly: false,
        writePaths: ["."],
      },
    });
    try {
      const provider = new GitWorktreeProvider({ worktreeRoot });
      const lease = await provider.acquire(
        writableProfile,
        {
          id: "worktree/task with spaces",
          workspace: repository,
          task: "Make an isolated change",
          acceptanceCriteria: [],
          writePaths: ["."],
          depth: 0,
        },
        { cwd: repository, agentDir: join(repository, ".pi") },
      );
      assert.ok(lease.worktreePath);
      assert.notEqual(lease.cwd, repository);
      assert.equal(
        (await readFile(join(lease.cwd, "README.md"), "utf8")).replace(/\r\n/g, "\n"),
        "initial\n",
      );
      await writeFile(join(lease.cwd, "agent-change.txt"), "isolated\n", "utf8");
      await lease.release();
      await lease.release();
      await assert.rejects(readFile(join(lease.cwd, "agent-change.txt")));

      let managedCwd = "";
      const manager = new PiAgentManager({
        create: async (childProfile, childTask, sessionOptions) => {
          managedCwd = sessionOptions.cwd;
          return fakeManagedAgent(childProfile, childTask, async () => undefined);
        },
      });
      const managedResult = await manager.run(
        writableProfile,
        {
          id: "manager-worktree-task",
          workspace: repository,
          task: "Run inside an isolated workspace",
          acceptanceCriteria: [],
          writePaths: ["."],
          depth: 0,
        },
        {
          cwd: repository,
          agentDir: join(repository, ".pi"),
          workspaceProvider: provider,
        },
      );
      assert.equal(managedResult.status, "completed");
      assert.notEqual(managedCwd, repository);
      await assert.rejects(readFile(join(managedCwd, "README.md")));

      const readOnlyLease = await provider.acquire(
        profile({ id: "read-only-worktree" }),
        {
          id: "read-only-task",
          workspace: repository,
          task: "Inspect only",
          acceptanceCriteria: [],
          depth: 0,
        },
        { cwd: repository, agentDir: join(repository, ".pi") },
      );
      assert.equal(readOnlyLease.worktreePath, undefined);
      assert.equal(readOnlyLease.cwd, repository);
      await readOnlyLease.release();

      await assert.rejects(
        provider.acquire(
          writableProfile,
          {
            id: "mismatched-task",
            workspace: repository,
            task: "Reject mismatched cwd",
            acceptanceCriteria: [],
            writePaths: ["."],
            depth: 0,
          },
          { cwd: join(root, "other-cwd"), agentDir: join(root, ".pi") },
        ),
        WorkspaceIsolationError,
      );

      const failedRoot = join(root, "failed-worktrees");
      const failedProvider = new GitWorktreeProvider({
        worktreeRoot: failedRoot,
        baseRef: "does-not-exist",
      });
      await assert.rejects(
        failedProvider.acquire(
          writableProfile,
          {
            id: "failed-worktree-task",
            workspace: repository,
            task: "Fail before leaving a worktree",
            acceptanceCriteria: [],
            writePaths: ["."],
            depth: 0,
          },
          { cwd: repository, agentDir: join(repository, ".pi") },
        ),
        WorkspaceIsolationError,
      );
      assert.deepEqual(await readdir(failedRoot), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops a Pi Session before starting a turn beyond maxTurns", async () => {
    const faux = fauxProvider({
      provider: "faux-turn-limit",
      models: [{ id: "faux-model", reasoning: false }],
    });
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo turn-limit-test" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("This response should not be needed."),
    ]);

    const limited = profile({
      id: "turn-limited-agent",
      name: "turn-limited-agent",
      execution: {
        ...profile().execution,
        tools: ["bash"],
        readOnly: false,
        writePaths: ["."],
      },
      limits: {
        ...profile().limits,
        maxTurns: 1,
        timeoutSeconds: 10,
      },
    });
    const managed = await new PiSessionFactory().create(
      limited,
      { ...task, workspace: process.cwd(), writePaths: ["."] },
      {
        cwd: process.cwd(),
        agentDir: join(tmpdir(), "multi-agent-dev-turn-limit-test"),
        modelRuntime,
        modelAliases: { "coding-balanced": "faux-turn-limit/faux-model" },
      },
    );

    const result = await managed.prompt({ ...task, workspace: process.cwd(), writePaths: ["."] });
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "agent_max_turns_exceeded");
    assert.ok(result.usage);
    assert.ok(result.usage.totalTokens > 0);
    assert.equal(result.usage.costUsd, 0);
    await managed.cancel();
  });

  it("validates cost limits and stops a Session after the configured budget", async () => {
    assert.throws(
      () => validateProfile(profile({ limits: { ...profile().limits, maxCostUsd: -0.01 } })),
      /maxCostUsd must be a finite non-negative number/,
    );

    const faux = fauxProvider({
      provider: "faux-cost-limit",
      models: [{ id: "faux-model", reasoning: false }],
    });
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    });
    const expensiveProvider = {
      ...faux.provider,
      streamSimple: (...args: Parameters<typeof faux.provider.streamSimple>) => {
        const source = faux.provider.streamSimple(...args);
        const output = createAssistantMessageEventStream();
        void (async () => {
          for await (const event of source) {
            if (event.type === "done") {
              const message = {
                ...event.message,
                usage: {
                  ...event.message.usage,
                  cost: { ...event.message.usage.cost, total: 1 },
                },
              };
              output.push({ ...event, message });
              output.end(message);
            } else {
              output.push(event);
            }
          }
        })();
        return output;
      },
    };
    modelRuntime.registerNativeProvider(expensiveProvider);
    faux.setResponses([fauxAssistantMessage("This response exceeds the budget.")]);

    const limited = profile({
      id: "cost-limited-agent",
      name: "cost-limited-agent",
      limits: { ...profile().limits, maxCostUsd: 0.5, timeoutSeconds: 10 },
    });
    const managed = await new PiSessionFactory().create(
      limited,
      { ...task, workspace: process.cwd() },
      {
        cwd: process.cwd(),
        agentDir: join(tmpdir(), "multi-agent-dev-cost-limit-test"),
        modelRuntime,
        modelAliases: { "coding-balanced": "faux-cost-limit/faux-model" },
      },
    );

    const result = await managed.prompt({ ...task, workspace: process.cwd() });
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "agent_cost_limit_exceeded");
    assert.equal(result.usage?.costUsd, 1);
    await managed.cancel();
  });

  it("creates a runtime with Pi ModelRuntime without making a model request", async () => {
    const runtime = await createMultiAgentRuntimeAsync({
      modelRuntimeOptions: {
        modelsPath: null,
        allowModelNetwork: false,
      },
    });

    assert.ok(runtime.modelRuntime);
    assert.deepEqual(runtime.modelAliases, {});
  });

  it("routes model aliases through a host credential resolver without putting keys in routes", async () => {
    const faux = fauxProvider({
      provider: "faux-gateway",
      models: [{ id: "faux-model", reasoning: false }],
    });
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const resolvedProviders: string[] = [];
    const gateway = new ModelGateway(modelRuntime, {
      aliases: { "coding-balanced": "faux-gateway/faux-model" },
      credentials: {
        resolve: async (providerId) => {
          resolvedProviders.push(providerId);
          return "gateway-test-secret";
        },
      },
    });

    const resolved = await gateway.resolve("coding-balanced", "medium");
    assert.equal(resolved.model.id, "faux-model");
    assert.equal(resolved.providerId, "faux-gateway");
    assert.equal(resolved.credentialConfigured, true);
    assert.deepEqual(resolvedProviders, ["faux-gateway"]);
    assert.equal(JSON.stringify(gateway.aliases).includes("gateway-test-secret"), false);
    assert.throws(
      () => new ModelGateway(modelRuntime, { aliases: { broken: "api-key-only" } }),
      ModelGatewayConfigurationError,
    );
  });

  it("uses ModelGateway when creating the real Main Agent Pi Session", async () => {
    const faux = fauxProvider({
      provider: "faux-gateway-session",
      models: [{ id: "faux-model", reasoning: false }],
    });
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const gateway = new ModelGateway(modelRuntime, {
      aliases: { "coding-strong": "faux-gateway-session/faux-model" },
    });
    const runtime = createMultiAgentRuntime({ modelGateway: gateway });

    assert.equal(runtime.modelRuntime, modelRuntime);
    assert.equal(runtime.modelGateway, gateway);
    const agent = await runtime.createMainAgent({
      cwd: process.cwd(),
      workspace: process.cwd(),
      agentDir: join(tmpdir(), "multi-agent-dev-gateway-session-test"),
    });
    assert.equal(agent.profile.execution.model, "coding-strong");
    await agent.cancel();
  });

  it("loads project and user profiles with project precedence and saves approved versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-profiles-"));
    try {
      const store = new FileProfileStore({
        projectRoot: join(root, "project-agents"),
        userRoot: join(root, "user-agents"),
      });
      const base = createBuiltInProfiles("2026-07-30T00:00:00.000Z").find((item) => item.name === "researcher")!;
      const userProfile = {
        ...base,
        id: "user-researcher",
        lifecycle: { ...base.lifecycle, scope: "user" as const },
      };
      const projectProfile = {
        ...base,
        id: "project-researcher",
        description: "Project-specific researcher",
        lifecycle: { ...base.lifecycle, scope: "project" as const },
      };

      await store.saveApproved(userProfile, { approved: true, approvedBy: "test" });
      await store.saveApproved(projectProfile, { approved: true, approvedBy: "test" });

      const registry = new LayeredProfileRegistry();
      const loaded = await store.loadInto(registry);
      assert.equal(loaded.length, 2);
      assert.equal(registry.get("researcher").id, "project-researcher");
      assert.match(
        await readFile(join(root, "project-agents", ".versions", "researcher", "v1.json"), "utf8"),
        /approvedBy/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads approved profiles during async runtime bootstrap", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-runtime-profiles-"));
    try {
      const store = new FileProfileStore({
        projectRoot: join(root, "project-agents"),
        userRoot: join(root, "user-agents"),
      });
      const base = createBuiltInProfiles().find((item) => item.name === "researcher")!;
      const projectProfile = {
        ...base,
        id: "project-runtime-researcher",
        description: "Loaded during runtime bootstrap",
        lifecycle: { ...base.lifecycle, scope: "project" as const },
      };
      await store.saveApproved(projectProfile, { approved: true, approvedBy: "test" });

      const runtime = await createMultiAgentRuntimeAsync({
        profileStore: store,
        modelRuntimeOptions: { modelsPath: null, allowModelNetwork: false },
      });
      assert.equal(runtime.registry.get("researcher").id, "project-runtime-researcher");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not persist an ephemeral profile or an unapproved request", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-approval-"));
    try {
      const store = new FileProfileStore({
        projectRoot: join(root, "project-agents"),
        userRoot: join(root, "user-agents"),
      });
      const profile = {
        ...createBuiltInProfiles().find((item) => item.name === "researcher")!,
        lifecycle: {
          ...createBuiltInProfiles().find((item) => item.name === "researcher")!.lifecycle,
          persistence: "ephemeral" as const,
          scope: "task" as const,
        },
      };

      await assert.rejects(
        store.saveApproved(profile, { approved: true, approvedBy: "test" }),
        /Only persistent profiles can be saved/,
      );
      await assert.rejects(
        store.saveApproved({
          ...profile,
          lifecycle: {
            ...profile.lifecycle,
            persistence: "persistent" as const,
            scope: "project" as const,
          },
        }, { approved: true, approvedBy: "" }),
        /Explicit approval is required/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets the host approve a persistent profile without exposing persistence to Main Agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-persistent-service-"));
    try {
      const store = new FileProfileStore({
        projectRoot: join(root, "project-agents"),
        userRoot: join(root, "user-agents"),
      });
      const runtime = createMultiAgentRuntime({ profileStore: store });
      assert.ok(runtime.persistentProfiles instanceof PersistentProfileService);

      const created = await runtime.persistentProfiles!.createApproved(
        request({
          name: "approved-researcher",
          persistence: "persistent",
          scope: "project",
          createdBy: "user",
        }),
        { ...task, workspace: process.cwd() },
        { approved: true, approvedBy: "host-test" },
      );

      assert.equal(created.profile.lifecycle.persistence, "persistent");
      assert.equal(runtime.registry.get("approved-researcher").id, created.profile.id);
      assert.match(
        await readFile(join(root, "project-agents", "approved-researcher.json"), "utf8"),
        /approved-researcher/,
      );

      const mainAgentTools = createOrchestrationTools(
        runtime.factory,
        runtime.registry,
        runtime.manager,
        {
          workspace: process.cwd(),
          agentDir: join(root, ".pi"),
          depth: 0,
        },
      ).map((tool) => tool.name);
      assert.ok(!mainAgentTools.includes("persist_agent"));
      assert.ok(!mainAgentTools.includes("remove_persistent_agent"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unapproved persistence before registering a profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-unapproved-service-"));
    try {
      const store = new FileProfileStore({
        projectRoot: join(root, "project-agents"),
        userRoot: join(root, "user-agents"),
      });
      const runtime = createMultiAgentRuntime({ profileStore: store });

      await assert.rejects(
        runtime.persistentProfiles!.createApproved(
          request({
            name: "unapproved-researcher",
            persistence: "persistent",
            scope: "project",
            createdBy: "user",
          }),
          { ...task, workspace: process.cwd() },
          { approved: false, approvedBy: "host-test" } as never,
        ),
        /Explicit approval is required/,
      );
      assert.throws(() => runtime.registry.get("unapproved-researcher"), /not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back registry registration when persistent storage fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-persistence-rollback-"));
    try {
      const blockedRoot = join(root, "project-agents");
      await writeFile(blockedRoot, "not a directory", "utf8");
      const store = new FileProfileStore({
        projectRoot: blockedRoot,
        userRoot: join(root, "user-agents"),
      });
      const runtime = createMultiAgentRuntime({ profileStore: store });

      await assert.rejects(
        runtime.persistentProfiles!.createApproved(
          request({
            name: "rollback-researcher",
            persistence: "persistent",
            scope: "project",
            createdBy: "user",
          }),
          { ...task, workspace: process.cwd() },
          { approved: true, approvedBy: "host-test" },
        ),
      );
      assert.throws(() => runtime.registry.get("rollback-researcher"), /not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes only the approved persisted version", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-persistence-remove-"));
    try {
      const store = new FileProfileStore({
        projectRoot: join(root, "project-agents"),
        userRoot: join(root, "user-agents"),
      });
      const runtime = createMultiAgentRuntime({ profileStore: store });
      await runtime.persistentProfiles!.createApproved(
        request({
          name: "removable-researcher",
          persistence: "persistent",
          scope: "project",
          createdBy: "user",
        }),
        { ...task, workspace: process.cwd() },
        { approved: true, approvedBy: "host-test" },
      );

      await runtime.persistentProfiles!.removeApproved("removable-researcher", "host-test");
      assert.throws(() => runtime.registry.get("removable-researcher"), /not found/);
      await assert.rejects(
        readFile(join(root, "project-agents", "removable-researcher.json")),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat a built-in profile as an approved persisted file", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-dev-built-in-remove-"));
    try {
      const store = new FileProfileStore({
        projectRoot: join(root, "project-agents"),
        userRoot: join(root, "user-agents"),
      });
      const runtime = createMultiAgentRuntime({ profileStore: store });

      await assert.rejects(
        runtime.persistentProfiles!.removeApproved("researcher", "host-test"),
        ProfilePersistenceError,
      );
      assert.equal(runtime.registry.get("researcher").id, "builtin_researcher");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs Main Agent -> spawn_agent -> Sub Agent through the real Pi loop", async () => {
    const faux = fauxProvider({
      provider: "faux-e2e",
      models: [{ id: "faux-model", reasoning: false }],
    });
    const agentDir = join(tmpdir(), "multi-agent-dev-e2e");
    try {
      const modelRuntime = await ModelRuntime.create({
        modelsPath: null,
        allowModelNetwork: false,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("spawn_agent", {
          profile: {
            name: "one-off-researcher",
            description: "A temporary code researcher",
            responsibilities: ["Read the requested scope", "Return evidence"],
            requestedTools: ["read"],
            readOnly: true,
            reason: "The user request needs a focused specialist",
          },
          task: "Inspect the requested scope and summarize it",
          acceptanceCriteria: ["Return a concise specialist report"],
        }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Subagent report: the requested scope is understandable."),
        fauxAssistantMessage("Final orchestration answer: the specialist completed successfully."),
      ]);

      const runtime = createMultiAgentRuntime({
        modelRuntime,
        modelAliases: {
          "coding-strong": "faux-e2e/faux-model",
          "coding-balanced": "faux-e2e/faux-model",
        },
      });
      const mainAgent = await runtime.createMainAgent({
        cwd: process.cwd(),
        workspace: process.cwd(),
        agentDir,
      });
      await mainAgent.session.prompt("Use a temporary specialist to inspect this request.");

      const transcript = JSON.stringify(mainAgent.session.messages);
      assert.equal(faux.state.callCount, 3);
      assert.ok(runtime.registry.get("one-off-researcher").id.startsWith("agent_"));
      assert.match(transcript, /spawn_agent/);
      assert.match(transcript, /Subagent report/);
      assert.match(transcript, /Final orchestration answer/);
      await mainAgent.cancel();
    } finally {
      // Pi 0.83's FauxProviderHandle has no unregister API; the provider is test-local.
    }
  });
});

function workerScript(mode: "normal" | "never-ready" | "crash"): string {
  const runtimeModule = new URL("../src/index.js", import.meta.url).href;
  if (mode === "never-ready") {
    return "setTimeout(() => {}, 60_000);";
  }
  if (mode === "crash") {
    return [
      `import { createMultiAgentRuntime } from ${JSON.stringify(runtimeModule)};`,
      "const runtime = createMultiAgentRuntime();",
      "const handle = runtime.controlPlane.handle.bind(runtime.controlPlane);",
      "runtime.controlPlane.handle = async (input) => {",
      "  setTimeout(() => process.exit(17), 50);",
      "  await new Promise((resolve) => setTimeout(resolve, 5_000));",
      "  return handle(input);",
      "};",
      "const rpc = runtime.createControlPlaneWorkerRpcServer(process.stdin, process.stdout);",
      "rpc.start();",
    ].join("\n");
  }
  return [
    `import { createMultiAgentRuntime } from ${JSON.stringify(runtimeModule)};`,
    "const runtime = createMultiAgentRuntime();",
    "const rpc = runtime.createControlPlaneWorkerRpcServer(process.stdin, process.stdout, {",
    "  authorize: (token) => token === process.env.MULTI_AGENT_WORKER_TOKEN,",
    "});",
    "rpc.start();",
  ].join("\n");
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

function waitForWebSocketOpen(socket: NodeWebSocket): Promise<void> {
  if (socket.readyState === NodeWebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function nextWebSocketMessage(socket: NodeWebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData) => {
      cleanup();
      try {
        resolve(JSON.parse(rawDataToString(data)) as unknown);
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before a message arrived"));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function waitForWebSocketClose(socket: NodeWebSocket): Promise<number> {
  if (socket.readyState === NodeWebSocket.CLOSED) return Promise.resolve(1000);
  return new Promise((resolve) => {
    socket.once("close", (code: number) => resolve(code));
  });
}

function waitForUnexpectedWebSocketResponse(socket: NodeWebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Expected a WebSocket handshake rejection"));
    }, 5000);
    const onUnexpectedResponse = (
      _request: import("node:http").ClientRequest,
      response: import("node:http").IncomingMessage,
    ) => {
      clearTimeout(timer);
      cleanup();
      response.resume();
      resolve(response.statusCode ?? 0);
    };
    const onError = () => undefined;
    const cleanup = () => {
      socket.off("unexpected-response", onUnexpectedResponse);
      socket.off("error", onError);
    };
    socket.once("unexpected-response", onUnexpectedResponse);
    socket.once("error", onError);
  });
}

function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

class JsonlTestReader {
  private buffer = "";
  private readonly frames: unknown[] = [];
  private readonly waiters: Array<(frame: unknown) => void> = [];

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += chunk.toString();
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        const frame = JSON.parse(line) as unknown;
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.frames.push(frame);
      }
      newline = this.buffer.indexOf("\n");
    }
  };

  constructor(private readonly stream: PassThrough) {
    stream.on("data", this.onData);
  }

  next(): Promise<unknown> {
    const frame = this.frames.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.stream.off("data", this.onData);
  }
}
