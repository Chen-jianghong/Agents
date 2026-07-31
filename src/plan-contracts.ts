/**
 * Contracts for the planning and scheduling layer: Run, Task DAG, DAG
 * validation and Run/Task status snapshots.
 *
 * The DAG is the structured output of the Planner and the scheduling input
 * of the RunScheduler. Natural-language requests must never be passed
 * directly to Workers as executable instructions; they are converted into a
 * validated TaskDAG first (see multi-agent-development-project-plan.md §6).
 */

/** Lifecycle of one Run (one user request). */
export type RunStatus =
  | "created"
  | "planning"
  | "ready"
  | "running"
  | "integrating"
  | "reviewing"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Lifecycle of one task inside a Run. */
export type RunTaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "testing"
  | "succeeded"
  | "failed"
  | "cancelled";

/** One structured task produced by the Planner. */
export interface PlanTask {
  /** Unique within the Run. */
  id: string;
  title: string;
  /** Agent role: backend / frontend / qa / reviewer / ... or a dynamic profile name. */
  role: string;
  /** Ids of tasks that must succeed before this one starts. */
  dependsOn: string[];
  /** Optional model profile name; defaults to the role binding. */
  modelProfile?: string;
  /** Workspace-relative write boundaries. Empty for read-only tasks. */
  writePaths: string[];
  acceptanceCriteria: string[];
  testCommands: string[];
}

/** The structured plan: goal plus a task graph. */
export interface TaskDAG {
  goal: string;
  tasks: PlanTask[];
}

export type DAGIssueCode =
  | "empty_dag"
  | "missing_goal"
  | "missing_task_id"
  | "missing_title"
  | "missing_role"
  | "missing_acceptance_criteria"
  | "duplicate_task_id"
  | "self_dependency"
  | "missing_dependency"
  | "cyclic_dependency"
  | "overlapping_write_paths";

export interface DAGValidationIssue {
  code: DAGIssueCode;
  message: string;
  taskId?: string;
}

export interface DAGValidationResult {
  valid: boolean;
  issues: DAGValidationIssue[];
  /** Valid topological order of task ids (only present when valid). */
  topoOrder?: string[];
}

/** Outcome of one Planner invocation. */
export type PlanOutcome =
  | {
    status: "planned";
    dag: TaskDAG;
    validation: DAGValidationResult;
    rawOutput: string;
  }
  | {
    status: "planning_failed";
    reason: PlanFailureReason;
    rawOutput?: string;
  };

export type PlanFailureReason =
  | { code: "invalid_json"; message: string }
  | { code: "invalid_dag"; issues: DAGValidationIssue[] }
  | { code: "agent_failed"; message: string };

/** Public read-only snapshot of one task inside a Run. */
export interface RunTaskSnapshot {
  taskId: string;
  title: string;
  role: string;
  status: RunTaskStatus;
  dependsOn: string[];
  writePaths: string[];
  modelProfile?: string;
  agentTaskId?: string;
  profileId?: string;
  error?: { code: string; message: string };
  result?: unknown;
}

/** Public read-only snapshot of a whole Run. */
export interface RunSnapshot {
  runId: string;
  status: RunStatus;
  goal: string;
  workspace: string;
  maxParallel: number;
  dag?: TaskDAG;
  tasks: RunTaskSnapshot[];
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}

/** Result returned when a Run reaches a terminal state. */
export interface RunResult {
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
  goal: string;
  tasks: RunTaskSnapshot[];
  error?: { code: string; message: string };
}
