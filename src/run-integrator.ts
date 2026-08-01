/**
 * RunIntegrator: merges the changes of a Run's tasks into an integration
 * branch (multi-agent-development-project-plan.md §5.3 / §9).
 *
 * Every writable task captured its unified diff against the shared base
 * commit (AgentResult.diff). The integrator creates integration/<run-id>
 * from the same base, then applies each succeeded task's diff in dependency
 * order with `git apply`. An apply failure (e.g. two tasks editing the same
 * region) is reported as a conflict instead of aborting the repository.
 */
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import type { RunSnapshot } from "./plan-contracts.js";
import { topologicalOrder } from "./dag.js";

const execFileAsync = promisify(execFile);

export type IntegrationStatus =
  | "merged"
  | "conflict"
  | "no_changes"
  | "not_a_git_repo"
  | "not_ready"
  | "failed";

export interface IntegrationConflict {
  taskId: string;
  detail: string;
}

export interface IntegrationReport {
  runId: string;
  status: IntegrationStatus;
  branch?: string;
  baseCommit?: string;
  appliedTasks: string[];
  conflicts: IntegrationConflict[];
  message: string;
}

export interface MergeReport {
  runId: string;
  status: "merged" | "not_found" | "not_a_git_repo" | "failed";
  branch?: string;
  message: string;
}

export interface RunIntegratorOptions {
  /** Git repository the integration branch is created in. */
  workspace: string;
  gitExecutable?: string;
  commitAuthor?: { name: string; email: string };
  branchPrefix?: string;
}

export class RunIntegrator {
  private readonly workspace: string;
  private readonly gitExecutable: string;
  private readonly commitAuthor: { name: string; email: string };
  private readonly branchPrefix: string;

  constructor(options: RunIntegratorOptions) {
    this.workspace = options.workspace;
    this.gitExecutable = options.gitExecutable ?? "git";
    this.commitAuthor = options.commitAuthor ?? { name: "Multi-Agent Dev", email: "multi-agent-dev@localhost" };
    this.branchPrefix = options.branchPrefix ?? "integration";
  }

  /**
   * Integrate a Run's succeeded tasks into integration/<run-id>.
   * Only succeeds when the Run has reached a terminal state with every task
   * either succeeded or skipped (read-only tasks have no diff).
   */
  async integrate(run: RunSnapshot): Promise<IntegrationReport> {
    if (run.status !== "succeeded" && run.status !== "failed") {
      return {
        runId: run.runId,
        status: "not_ready",
        appliedTasks: [],
        conflicts: [],
        message: `Run ${run.runId} is ${run.status}; integrate it after it finishes`,
      };
    }

    let repoRoot: string;
    try {
      repoRoot = await this.git("rev-parse", "--show-toplevel");
    } catch {
      return {
        runId: run.runId,
        status: "not_a_git_repo",
        appliedTasks: [],
        conflicts: [],
        message: `Workspace ${this.workspace} is not a Git repository`,
      };
    }

    const baseCommit = await this.git("rev-parse", "HEAD");
    const branch = `${this.branchPrefix}/${run.runId}`;
    const appliedTasks: string[] = [];
    const conflicts: IntegrationConflict[] = [];

    try {
      await this.git("checkout", "-B", branch);
      await this.git("reset", "--hard", baseCommit);

      // Apply task diffs in dependency order.
      const order = this.taskOrder(run);
      for (const taskId of order) {
        const task = run.tasks.find((item) => item.taskId === taskId);
        const diff = (task?.result as { diff?: string } | undefined)?.diff;
        if (!diff) continue; // read-only task or no changes
        const applied = await this.applyDiff(taskId, diff);
        if (!applied) {
          conflicts.push({
            taskId,
            detail: `Task ${taskId} conflicts with the changes already applied`,
          });
          break;
        }
        appliedTasks.push(taskId);
      }
    } catch (error) {
      return {
        runId: run.runId,
        status: "failed",
        branch,
        baseCommit,
        appliedTasks,
        conflicts,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (conflicts.length > 0) {
      return {
        runId: run.runId,
        status: "conflict",
        branch,
        baseCommit,
        appliedTasks,
        conflicts,
        message: `${conflicts.length} task(s) could not be integrated automatically`,
      };
    }
    if (appliedTasks.length === 0) {
      return {
        runId: run.runId,
        status: "no_changes",
        branch,
        baseCommit,
        appliedTasks,
        conflicts,
        message: "No task produced changes to integrate",
      };
    }

    return {
      runId: run.runId,
      status: "merged",
      branch,
      baseCommit,
      appliedTasks,
      conflicts,
      message: `Integrated ${appliedTasks.length} task(s) into ${branch}`,
    };
  }

  /**
   * Merge the Run's integration branch into the default branch (main).
   * Requires the integration branch to exist (call integrate first).
   */
  async merge(runId: string): Promise<MergeReport> {
    let repoRoot: string;
    try {
      repoRoot = await this.git("rev-parse", "--show-toplevel");
    } catch {
      return {
        runId,
        status: "not_a_git_repo",
        message: `Workspace ${this.workspace} is not a Git repository`,
      };
    }
    const branch = `${this.branchPrefix}/${runId}`;
    try {
      await this.git("rev-parse", "--verify", branch);
    } catch {
      return {
        runId,
        status: "not_found",
        branch,
        message: `Integration branch ${branch} does not exist; integrate the Run first`,
      };
    }

    // Determine the default branch (main, master, or the current branch).
    let defaultBranch = "main";
    try {
      const current = await this.git("branch", "--show-current");
      if (current.trim()) defaultBranch = current.trim();
    } catch {
      // fall back to "main"
    }

    try {
      await this.git("checkout", defaultBranch);
      await this.git("merge", "--no-ff", branch, "-m", `merge run ${runId} (Multi-Agent Dev)`);
      return {
        runId,
        status: "merged",
        branch,
        message: `Merged ${branch} into ${defaultBranch}`,
      };
    } catch (error) {
      return {
        runId,
        status: "failed",
        branch,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Apply one task's diff; commits it when clean. */
  private async applyDiff(taskId: string, diff: string): Promise<boolean> {    // Pre-check without touching the working tree.
    try {
      await this.gitApply(diff, true);
    } catch {
      return false;
    }
    await this.gitApply(diff, false);
    await this.git(
      "commit",
      "-m",
      `task ${taskId}`,
      "-m",
      "Integrated by Multi-Agent Dev",
    );
    return true;
  }

  private taskOrder(run: RunSnapshot): string[] {
    if (!run.dag) return run.tasks.map((task) => task.taskId);
    const order = topologicalOrder(run.dag);
    if (!order) return run.tasks.map((task) => task.taskId);
    return order;
  }

  private async git(...args: string[]): Promise<string> {
    try {
      const result = await execFileAsync(this.gitExecutable, ["-C", this.workspace, ...args], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        ...(this.commitAuthor
          ? {
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: this.commitAuthor.name,
              GIT_AUTHOR_EMAIL: this.commitAuthor.email,
              GIT_COMMITTER_NAME: this.commitAuthor.name,
              GIT_COMMITTER_EMAIL: this.commitAuthor.email,
            },
          }
          : {}),
      });
      return result.stdout.trim();
    } catch (error) {
      throw new Error(`Git command failed: ${errorMessage(error)}`);
    }
  }

  /** Pipe a diff into `git apply` (with optional --check preflight). */
  private async gitApply(diff: string, checkOnly: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = checkOnly
        ? ["-C", this.workspace, "apply", "--check", "--index"]
        : ["-C", this.workspace, "apply", "--index"];
      const child = spawn(this.gitExecutable, args, {
        env: this.commitAuthor
          ? {
            ...process.env,
            GIT_AUTHOR_NAME: this.commitAuthor.name,
            GIT_AUTHOR_EMAIL: this.commitAuthor.email,
            GIT_COMMITTER_NAME: this.commitAuthor.name,
            GIT_COMMITTER_EMAIL: this.commitAuthor.email,
          }
          : process.env,
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `git apply exited with code ${code ?? "none"}`));
        }
      });
      child.stdin.end(diff);
    });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
