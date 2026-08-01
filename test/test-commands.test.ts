import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiAgentManager, PiSessionFactory } from "../src/index.js";
import type { AgentProfile, AgentResult, AgentTask, ManagedAgent } from "../src/index.js";

function profile(id = "test-agent"): AgentProfile {
  return {
    id,
    name: id,
    version: 1,
    description: "Test profile",
    kind: "subagent",
    identity: {
      responsibilities: ["Run"],
      nonResponsibilities: [],
      systemPrompt: "You are a test agent.",
    },
    execution: {
      model: "coding-balanced",
      thinkingLevel: "medium",
      tools: ["read"],
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
    limits: { maxTurns: 5, timeoutSeconds: 30, maxConcurrentChildren: 0 },
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
      createdAt: "2026-07-31T00:00:00.000Z",
    },
  };
}

function sessionFactoryReturning(status: AgentResult["status"]): PiSessionFactory {
  return {
    create: async (_profile: AgentProfile, _task: AgentTask): Promise<ManagedAgent> => ({
      agentId: _profile.id,
      sessionId: "session-1",
      profile: _profile,
      session: {} as never,
      status: "completed",
      subscribe: () => () => undefined,
      cancel: async () => undefined,
      prompt: async (runTask: AgentTask): Promise<AgentResult> => ({
        agentId: _profile.id,
        agentTaskId: runTask.id,
        status,
        output: "agent output",
        changedFiles: [],
        tests: [],
        risks: [],
      }),
    }),
  };
}

describe("host test command execution", () => {
  it("runs test commands after the agent finishes and records the outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-commands-"));
    try {
      const manager = new PiAgentManager(sessionFactoryReturning("completed"));
      const result = await manager.run(profile(), {
        id: "task-1",
        workspace: root,
        task: "Run tests",
        acceptanceCriteria: [],
        testCommands: ["node -e console.log('test-ok')"],
        depth: 0,
      }, { cwd: root, agentDir: join(root, ".pi") });

      assert.equal(result.status, "completed");
      assert.equal(result.tests.length, 1);
      assert.equal(result.tests[0]?.command, "node -e console.log('test-ok')");
      assert.equal(result.tests[0]?.passed, true);
      assert.match(result.tests[0]?.output ?? "", /test-ok/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a failing test command as failed without failing the task", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-commands-fail-"));
    try {
      const manager = new PiAgentManager(sessionFactoryReturning("completed"));
      const result = await manager.run(profile(), {
        id: "task-2",
        workspace: root,
        task: "Run failing test",
        acceptanceCriteria: [],
        testCommands: ["node -e process.exit(1)"],
        depth: 0,
      }, { cwd: root, agentDir: join(root, ".pi") });

      assert.equal(result.status, "completed", "task itself still succeeds");
      assert.equal(result.tests.length, 1);
      assert.equal(result.tests[0]?.passed, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not run test commands when the agent failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-commands-skip-"));
    try {
      const manager = new PiAgentManager(sessionFactoryReturning("failed"));
      const result = await manager.run(profile(), {
        id: "task-3",
        workspace: root,
        task: "Failing agent",
        acceptanceCriteria: [],
        testCommands: ["node -e console.log('should-not-run')"],
        depth: 0,
      }, { cwd: root, agentDir: join(root, ".pi") });

      assert.equal(result.status, "failed");
      assert.equal(result.tests.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
