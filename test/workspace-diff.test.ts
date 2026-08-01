import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { GitWorktreeProvider } from "../src/workspace.js";
import { PiAgentManager, PiSessionFactory } from "../src/index.js";
import type { AgentProfile, AgentResult, AgentTask, ManagedAgent } from "../src/index.js";

const execFile = promisify(execFileCallback);

async function initRepository(repository: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  await execFile("git", ["init", repository]);
  await execFile("git", ["-C", repository, "config", "user.email", "agent-test@example.com"]);
  await execFile("git", ["-C", repository, "config", "user.name", "Agent Test"]);
  await writeFile(join(repository, "README.md"), "initial\n", "utf8");
  await execFile("git", ["-C", repository, "add", "README.md"]);
  await execFile("git", ["-C", repository, "commit", "-m", "initial"]);
}

function writableProfile(id: string): AgentProfile {
  return {
    id,
    name: `writable-${id}`,
    version: 1,
    description: "Writable test profile",
    kind: "subagent",
    identity: {
      responsibilities: ["Make changes"],
      nonResponsibilities: [],
      systemPrompt: "You are a writable agent.",
    },
    execution: {
      model: "coding-balanced",
      thinkingLevel: "medium",
      tools: ["read", "write", "edit", "bash"],
      readOnly: false,
      writePaths: ["."],
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
    limits: { maxTurns: 20, timeoutSeconds: 60, maxConcurrentChildren: 0 },
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

function task(repository: string): AgentTask {
  return {
    id: "diff-task",
    workspace: repository,
    task: "Make an isolated change",
    acceptanceCriteria: [],
    writePaths: ["."],
    depth: 0,
  };
}

describe("Git worktree diff capture", () => {
  it("captures committed and uncommitted changes against the task base", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-diff-"));
    const repository = join(root, "repository");
    const worktreeRoot = join(root, "worktrees");
    await initRepository(repository);

    const provider = new GitWorktreeProvider({ worktreeRoot });
    const lease = await provider.acquire(writableProfile("diff-agent"), task(repository), {
      cwd: repository,
      agentDir: join(repository, ".pi"),
    });
    try {
      // Uncommitted change inside the worktree.
      await writeFile(join(lease.cwd, "feature.ts"), "export const x = 1;\n", "utf8");
      // Committed change inside the worktree.
      await execFile("git", ["-C", lease.cwd, "add", "feature.ts"]);
      await execFile("git", ["-C", lease.cwd, "commit", "-m", "add feature"]);

      const diff = await lease.captureDiff!();
      assert.ok(diff, "diff is captured");
      assert.match(diff!, /feature\.ts/);
      assert.match(diff!, /export const x = 1/);
    } finally {
      await lease.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when the worktree has no changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-diff-empty-"));
    const repository = join(root, "repository");
    const worktreeRoot = join(root, "worktrees");
    await initRepository(repository);

    const provider = new GitWorktreeProvider({ worktreeRoot });
    const lease = await provider.acquire(writableProfile("diff-agent"), task(repository), {
      cwd: repository,
      agentDir: join(repository, ".pi"),
    });
    try {
      const diff = await lease.captureDiff!();
      assert.equal(diff, undefined);
    } finally {
      await lease.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attaches the diff to the Agent result before releasing the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-agent-diff-manager-"));
    const repository = join(root, "repository");
    const worktreeRoot = join(root, "worktrees");
    await initRepository(repository);

    // Fake session that writes a file inside its workspace during prompt().
    const sessionFactory: PiSessionFactory = {
      create: async (_profile: AgentProfile, _agentTask: AgentTask, options) => {
        // options.cwd is the worktree path handed to the session.
        const workspaceCwd = options.cwd;
        let completed = false;
        const managed: ManagedAgent = {
          agentId: "diff-agent",
          sessionId: "session-1",
          profile: _profile,
          session: {} as never,
          status: "completed",
          subscribe: () => () => undefined,
          cancel: async () => undefined,
          prompt: async (runTask: AgentTask) => {
            if (!completed) {
              await writeFile(join(workspaceCwd, "changed.txt"), "hello\n", "utf8");
              completed = true;
            }
            const result: AgentResult = {
              agentId: "diff-agent",
              agentTaskId: runTask.id,
              status: "completed",
              output: "done",
              changedFiles: ["changed.txt"],
              tests: [],
              risks: [],
            };
            return result;
          },
        };
        return managed;
      },
    };

    const manager = new PiAgentManager(sessionFactory as PiSessionFactory);
    const provider = new GitWorktreeProvider({ worktreeRoot });
    const result = await manager.run(writableProfile("diff-agent"), task(repository), {
      cwd: repository,
      agentDir: join(repository, ".pi"),
      workspaceProvider: provider,
    });

    assert.equal(result.status, "completed");
    assert.ok(result.diff, "result includes a diff");
    assert.match(result.diff!, /changed\.txt/);
    await rm(root, { recursive: true, force: true });
  });
});
