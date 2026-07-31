/**
 * Task DAG validation and scheduling helpers.
 *
 * The validator enforces the task constraints from
 * multi-agent-development-project-plan.md §6.1: unique ids, valid
 * dependencies, acyclicity and non-overlapping write boundaries. The
 * transition helpers drive the RunScheduler: which pending tasks become
 * ready, and which pending tasks are blocked by a failed/cancelled
 * dependency.
 */
import type {
  DAGValidationIssue,
  DAGValidationResult,
  PlanTask,
  RunTaskStatus,
  TaskDAG,
} from "./plan-contracts.js";

/**
 * Validate a TaskDAG. Returns all structural issues; when valid it also
 * returns the topological order of task ids.
 */
export function validateDAG(dag: TaskDAG): DAGValidationResult {
  const issues: DAGValidationIssue[] = [];
  const tasks = dag.tasks ?? [];

  if (dag.goal.trim().length === 0) {
    issues.push({ code: "missing_goal", message: "DAG goal must not be empty" });
  }

  if (tasks.length === 0) {
    issues.push({ code: "empty_dag", message: "DAG must contain at least one task" });
    return { valid: false, issues };
  }

  const byId = new Map<string, PlanTask>();
  for (const task of tasks) {
    if (task.id.trim().length === 0) {
      issues.push({ code: "missing_task_id", message: "every task must have an id", taskId: task.id });
    } else if (byId.has(task.id)) {
      issues.push({ code: "duplicate_task_id", message: `task id ${task.id} is not unique`, taskId: task.id });
    } else {
      byId.set(task.id, task);
    }
  }

  for (const task of tasks) {
    if (task.title.trim().length === 0) {
      issues.push({ code: "missing_title", message: `task ${task.id} must have a title`, taskId: task.id });
    }
    if (task.role.trim().length === 0) {
      issues.push({ code: "missing_role", message: `task ${task.id} must specify a role`, taskId: task.id });
    }
    if (task.acceptanceCriteria.length === 0) {
      issues.push({
        code: "missing_acceptance_criteria",
        message: `task ${task.id} must include acceptance criteria`,
        taskId: task.id,
      });
    }
    for (const dep of task.dependsOn) {
      if (dep === task.id) {
        issues.push({ code: "self_dependency", message: `task ${task.id} depends on itself`, taskId: task.id });
      } else if (!byId.has(dep)) {
        issues.push({
          code: "missing_dependency",
          message: `task ${task.id} depends on unknown task ${dep}`,
          taskId: task.id,
        });
      }
    }
  }

  // Cycle detection is only meaningful once dependencies are resolvable.
  const hasDependencyIssues = issues.some(
    (issue) => issue.code === "self_dependency" || issue.code === "missing_dependency",
  );
  const order = hasDependencyIssues ? null : topologicalOrder(dag);
  if (!hasDependencyIssues && order === null) {
    issues.push({ code: "cyclic_dependency", message: "task dependencies contain a cycle" });
  }

  issues.push(...findWritePathConflicts(tasks));

  if (issues.length > 0) {
    return { valid: false, issues };
  }
  return { valid: true, issues, topoOrder: order! };
}

/**
 * Kahn topological sort. Returns the task ids in dependency order, or null
 * when the graph contains a cycle (or unresolved dependencies).
 */
export function topologicalOrder(dag: TaskDAG): string[] | null {
  const tasks = dag.tasks;
  const indegree = new Map<string, number>();
  const adjacents = new Map<string, string[]>();

  for (const task of tasks) {
    indegree.set(task.id, task.dependsOn.length);
    adjacents.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      adjacents.get(dep)?.push(task.id);
    }
  }

  const queue: string[] = [];
  for (const task of tasks) {
    if ((indegree.get(task.id) ?? 0) === 0) queue.push(task.id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adjacents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  return order.length === tasks.length ? order : null;
}

/** Transitions the scheduler must apply to pending tasks. */
export interface TaskTransitions {
  /** Pending tasks whose dependencies are all satisfied. */
  readyTaskIds: string[];
  /** Pending tasks blocked by a failed/cancelled dependency (mark cancelled). */
  blockedTaskIds: string[];
}

/**
 * Compute which pending tasks become ready and which become blocked, based
 * on the current status of every task in the DAG.
 */
export function computeTaskTransitions(
  dag: TaskDAG,
  statuses: ReadonlyMap<string, RunTaskStatus>,
): TaskTransitions {
  const readyTaskIds: string[] = [];
  const blockedTaskIds: string[] = [];

  for (const task of dag.tasks) {
    // Unrecorded tasks are pending (not yet scheduled).
    if ((statuses.get(task.id) ?? "pending") !== "pending") continue;

    const deps = task.dependsOn;
    if (deps.length === 0) {
      readyTaskIds.push(task.id);
      continue;
    }

    let allSucceeded = true;
    let anyBlocked = false;
    for (const dep of deps) {
      const depStatus = statuses.get(dep) ?? "pending";
      if (depStatus === "succeeded") continue;
      allSucceeded = false;
      if (depStatus === "failed" || depStatus === "cancelled") {
        anyBlocked = true;
      }
    }
    if (anyBlocked) {
      blockedTaskIds.push(task.id);
    } else if (allSucceeded) {
      readyTaskIds.push(task.id);
    }
  }

  return { readyTaskIds, blockedTaskIds };
}

function findWritePathConflicts(tasks: readonly PlanTask[]): DAGValidationIssue[] {
  const writable = tasks.filter((task) => task.writePaths.length > 0);
  const issues: DAGValidationIssue[] = [];
  for (let i = 0; i < writable.length; i++) {
    for (let j = i + 1; j < writable.length; j++) {
      const a = writable[i]!;
      const b = writable[j]!;
      if (pathsOverlap(a.writePaths, b.writePaths)) {
        issues.push({
          code: "overlapping_write_paths",
          message: `write paths of tasks ${a.id} and ${b.id} overlap; they must not modify the same files`,
          taskId: a.id,
        });
      }
    }
  }
  return issues;
}

function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const pathA of a) {
    for (const pathB of b) {
      if (pathContains(pathA, pathB) || pathContains(pathB, pathA)) return true;
    }
  }
  return false;
}

/**
 * True when `candidate` lives inside `root` as workspace-relative paths.
 * "." (or an empty string) is the whole workspace and contains everything,
 * so whole-workspace writable tasks conflict with every other writable task.
 */
function pathContains(root: string, candidate: string): boolean {
  const normalizedRoot = normalizePathSegment(root);
  const normalizedCandidate = normalizePathSegment(candidate);
  if (normalizedRoot === ".") return true;
  if (normalizedRoot === normalizedCandidate) return true;
  return normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function normalizePathSegment(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed === "" ? "." : trimmed;
}
