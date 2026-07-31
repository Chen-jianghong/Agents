import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentProfile, AgentTask } from "./contracts.js";
import { isPathInside } from "./tool-policy.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceAcquireOptions {
  cwd: string;
  agentDir: string;
}

export interface AgentWorkspaceLease {
  readonly sourceWorkspace: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly worktreePath?: string;
  release(): Promise<void>;
}

export interface AgentWorkspaceProvider {
  acquire(
    profile: AgentProfile,
    task: AgentTask,
    options: WorkspaceAcquireOptions,
  ): Promise<AgentWorkspaceLease>;
}

export class WorkspaceIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceIsolationError";
  }
}

/** Keeps the existing in-place execution behavior when no isolation is needed. */
export class PassthroughWorkspaceProvider implements AgentWorkspaceProvider {
  async acquire(
    _profile: AgentProfile,
    task: AgentTask,
    options: WorkspaceAcquireOptions,
  ): Promise<AgentWorkspaceLease> {
    assertSameWorkspace(task.workspace, options.cwd);
    return {
      sourceWorkspace: resolve(task.workspace),
      cwd: resolve(options.cwd),
      agentDir: resolve(options.agentDir),
      release: async () => undefined,
    };
  }
}

export interface GitWorktreeProviderOptions {
  worktreeRoot: string;
  baseRef?: string;
  gitExecutable?: string;
}

/**
 * Creates one detached Git worktree per writable Agent task. The provider is
 * deliberately independent from Pi so it can also be replaced by a
 * container/workspace provider later.
 */
export class GitWorktreeProvider implements AgentWorkspaceProvider {
  private readonly worktreeRoot: string;
  private readonly baseRef: string;
  private readonly gitExecutable: string;

  constructor(options: GitWorktreeProviderOptions) {
    this.worktreeRoot = resolve(options.worktreeRoot);
    this.baseRef = options.baseRef ?? "HEAD";
    this.gitExecutable = options.gitExecutable ?? "git";
    if (this.baseRef.length === 0 || this.baseRef.startsWith("-") || this.baseRef.includes("\0")) {
      throw new WorkspaceIsolationError("Git worktree baseRef is invalid");
    }
  }

  async acquire(
    profile: AgentProfile,
    task: AgentTask,
    options: WorkspaceAcquireOptions,
  ): Promise<AgentWorkspaceLease> {
    assertSameWorkspace(task.workspace, options.cwd);
    const sourceWorkspace = resolve(task.workspace);
    if (profile.execution.readOnly || profile.execution.writePaths.length === 0) {
      return new PassthroughWorkspaceProvider().acquire(profile, task, options);
    }

    const repositoryRoot = await this.git("-C", sourceWorkspace, "rev-parse", "--show-toplevel");
    await mkdir(this.worktreeRoot, { recursive: true });
    const slug = sanitizeTaskId(task.id);
    const worktreePath = resolve(this.worktreeRoot, `${slug}-${randomUUID()}`);
    if (!isPathInside(this.worktreeRoot, worktreePath)) {
      throw new WorkspaceIsolationError("Git worktree path escaped the configured worktree root");
    }

    try {
      await this.git(
        "-C",
        repositoryRoot,
        "worktree",
        "add",
        "--detach",
        worktreePath,
        this.baseRef,
      );
    } catch (error) {
      try {
        await this.git("-C", repositoryRoot, "worktree", "remove", "--force", worktreePath);
      } catch {
        // The add may have failed before Git registered the path.
      }
      throw new WorkspaceIsolationError(`Unable to create Git worktree: ${errorMessage(error)}`);
    }

    let released = false;
    let releasing: Promise<void> | undefined;
    return {
      sourceWorkspace,
      cwd: worktreePath,
      agentDir: resolve(worktreePath, ".pi"),
      worktreePath,
      release: async () => {
        if (released) return;
        if (!releasing) {
          releasing = this.git("-C", repositoryRoot, "worktree", "remove", "--force", worktreePath)
            .then(() => {
              released = true;
            })
            .catch((error) => {
              releasing = undefined;
              throw new WorkspaceIsolationError(`Unable to release Git worktree: ${errorMessage(error)}`);
            });
        }
        await releasing;
      },
    };
  }

  private async git(...args: string[]): Promise<string> {
    try {
      const result = await execFileAsync(this.gitExecutable, args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      return result.stdout.trim();
    } catch (error) {
      throw new WorkspaceIsolationError(`Git command failed: ${errorMessage(error)}`);
    }
  }
}

function assertSameWorkspace(taskWorkspace: string, cwd: string): void {
  if (resolve(taskWorkspace) !== resolve(cwd)) {
    throw new WorkspaceIsolationError("Task workspace must match the configured Agent cwd");
  }
}

function sanitizeTaskId(taskId: string): string {
  const slug = taskId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "agent-task";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
