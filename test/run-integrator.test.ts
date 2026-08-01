import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { RunIntegrator } from "../src/run-integrator.js";
import type { RunSnapshot, RunTaskSnapshot } from "../src/plan-contracts.js";

const execFile = promisify(execFileCallback);

async function initRepository(repository: string): Promise<string> {
  await mkdir(repository, { recursive: true });
  await execFile("git", ["init", repository]);
  await execFile("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await execFile("git", ["-C", repository, "config", "user.name", "Test"]);
  await writeFile(join(repository, "README.md"), "init\n", "utf8");
  await execFile("git", ["-C", repository, "add", "."]);
  await execFile("git", ["-C", repository, "commit", "-m", "base"]);
  return (await execFile("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
}

/** Make a change in the repo, capture its diff against HEAD, then restore. */
async function captureChangePatch(repository: string, fileName: string, content: string): Promise<string> {
  const base = await execFile("git", ["-C", repository, "rev-parse", "HEAD"]).then((r) => r.stdout.trim());
  await writeFile(join(repository, fileName), content, "utf8");
  await execFile("git", ["-C", repository, "add", "-A"]);
  const patch = (await execFile("git", ["-C", repository, "diff", "--cached", base])).stdout;
  await execFile("git", ["-C", repository, "reset", "--hard", "HEAD"]);
  return patch;
}

function taskSnapshot(taskId: string, diff?: string): RunTaskSnapshot {
  return {
    taskId,
    title: taskId,
    role: "backend",
    status: "succeeded",
    dependsOn: [],
    writePaths: [],
    ...(diff ? { result: { status: "completed", diff, changedFiles: [], tests: [], risks: [] } } : {}),
  };
}

function runSnapshot(runId: string, tasks: RunTaskSnapshot[], workspace: string): RunSnapshot {
  return {
    runId,
    status: "succeeded",
    goal: "g",
    workspace,
    maxParallel: 2,
    dag: { goal: "g", tasks: tasks.map((t) => ({
      id: t.taskId,
      title: t.title,
      role: t.role,
      dependsOn: t.dependsOn,
      writePaths: [],
      acceptanceCriteria: ["a"],
      testCommands: [],
    })) },
    tasks,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
}

describe("RunIntegrator", () => {
  it("merges task diffs into an integration branch in dependency order", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrator-"));
    const repository = join(root, "repository");
    await initRepository(repository);

    const patchA = await captureChangePatch(repository, "a.txt", "task A\n");
    const patchB = await captureChangePatch(repository, "b.txt", "task B\n");

    const run = runSnapshot("run_test", [
      taskSnapshot("a", patchA),
      taskSnapshot("b", patchB),
    ], repository);

    const integrator = new RunIntegrator({ workspace: repository });
    const report = await integrator.integrate(run);

    assert.equal(report.status, "merged");
    assert.deepEqual(report.appliedTasks, ["a", "b"]);
    assert.equal(report.branch, "integration/run_test");

    // The integration branch contains both changes.
    const a = await execFile("git", ["-C", repository, "show", `${report.branch}:a.txt`]).then((r) => r.stdout.trim());
    const b = await execFile("git", ["-C", repository, "show", `${report.branch}:b.txt`]).then((r) => r.stdout.trim());
    assert.equal(a, "task A");
    assert.equal(b, "task B");
    await rm(root, { recursive: true, force: true });
  });

  it("reports a conflict when two tasks edit the same region", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrator-conflict-"));
    const repository = join(root, "repository");
    await initRepository(repository);

    const patch1 = await captureChangePatch(repository, "README.md", "init\nchange one\n");
    const patch2 = await captureChangePatch(repository, "README.md", "init\nchange two\n");

    const run = runSnapshot("run_conflict", [
      taskSnapshot("t1", patch1),
      taskSnapshot("t2", patch2),
    ], repository);

    const integrator = new RunIntegrator({ workspace: repository });
    const report = await integrator.integrate(run);

    assert.equal(report.status, "conflict");
    assert.equal(report.conflicts.length, 1);
    assert.equal(report.conflicts[0]?.taskId, "t2");
    await rm(root, { recursive: true, force: true });
  });

  it("returns not_a_git_repo for a plain directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrator-no-git-"));
    try {
      const run = runSnapshot("run_x", [taskSnapshot("a", "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+x\n")], root);
      const integrator = new RunIntegrator({ workspace: root });
      const report = await integrator.integrate(run);
      assert.equal(report.status, "not_a_git_repo");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns not_ready while the Run is still running", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrator-not-ready-"));
    try {
      const run = { ...runSnapshot("run_y", [taskSnapshot("a")], root), status: "running" as const };
      const integrator = new RunIntegrator({ workspace: root });
      const report = await integrator.integrate(run);
      assert.equal(report.status, "not_ready");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
