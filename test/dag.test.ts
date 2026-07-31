import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTaskTransitions, topologicalOrder, validateDAG } from "../src/dag.js";
import type { PlanTask, RunTaskStatus, TaskDAG } from "../src/plan-contracts.js";

function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: "t1",
    title: "Task 1",
    role: "backend",
    dependsOn: [],
    writePaths: ["server/modules/members"],
    acceptanceCriteria: ["implement the API"],
    testCommands: ["npm test -- members"],
    ...overrides,
  };
}

function dag(tasks: PlanTask[], goal = "Implement members management"): TaskDAG {
  return { goal, tasks };
}

function assertCodes(result: ReturnType<typeof validateDAG>, codes: string[]): void {
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.issues.map((issue) => issue.code).sort(),
    [...codes].sort(),
  );
}

describe("validateDAG", () => {
  it("accepts a valid DAG with parallel tasks and a dependent task", () => {
    const result = validateDAG(dag([
      task({ id: "backend", writePaths: ["server/modules/members"] }),
      task({ id: "frontend", writePaths: ["web/src/pages/members"] }),
      task({ id: "qa", role: "qa", dependsOn: ["backend", "frontend"], writePaths: [] }),
    ]));
    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.topoOrder, ["backend", "frontend", "qa"]);
  });

  it("rejects an empty DAG", () => {
    assertCodes(validateDAG(dag([])), ["empty_dag"]);
  });

  it("rejects a DAG without a goal", () => {
    assertCodes(validateDAG(dag([task()], "  ")), ["missing_goal"]);
  });

  it("rejects duplicate task ids", () => {
    assertCodes(validateDAG(dag([
      task({ id: "dup" }),
      task({ id: "dup", writePaths: ["other"] }),
    ])), ["duplicate_task_id"]);
  });

  it("rejects a task with an empty id", () => {
    assertCodes(validateDAG(dag([task({ id: "" })])), ["missing_task_id"]);
  });

  it("rejects a missing dependency", () => {
    assertCodes(validateDAG(dag([task({ dependsOn: ["nope"] })])), ["missing_dependency"]);
  });

  it("rejects a self dependency", () => {
    assertCodes(validateDAG(dag([task({ dependsOn: ["t1"] })])), ["self_dependency"]);
  });

  it("rejects a dependency cycle", () => {
    assertCodes(validateDAG(dag([
      task({ id: "a", dependsOn: ["b"] }),
      task({ id: "b", dependsOn: ["a"], writePaths: ["b"] }),
    ])), ["cyclic_dependency"]);
  });

  it("rejects missing title, role and acceptance criteria", () => {
    assertCodes(validateDAG(dag([
      task({ title: "  ", role: "  ", acceptanceCriteria: [] }),
    ])), ["missing_title", "missing_role", "missing_acceptance_criteria"]);
  });

  it("rejects overlapping write paths between two writable tasks", () => {
    assertCodes(validateDAG(dag([
      task({ id: "a", writePaths: ["src"] }),
      task({ id: "b", writePaths: ["src/components"] }),
    ])), ["overlapping_write_paths"]);
  });

  it("treats a whole-workspace writable task as conflicting with every other writable task", () => {
    assertCodes(validateDAG(dag([
      task({ id: "a", writePaths: ["."] }),
      task({ id: "b", writePaths: ["src"] }),
    ])), ["overlapping_write_paths"]);
  });

  it("does not flag read-only tasks for write path conflicts", () => {
    const result = validateDAG(dag([
      task({ id: "a", writePaths: ["src"] }),
      task({ id: "b", role: "reviewer", writePaths: [], dependsOn: ["a"] }),
    ]));
    assert.equal(result.valid, true);
  });

  it("reports both structural and path issues together", () => {
    assertCodes(validateDAG(dag([
      task({ id: "a", writePaths: ["src"], dependsOn: ["missing"] }),
      task({ id: "a", writePaths: ["src"] }),
    ])), ["missing_dependency", "duplicate_task_id", "overlapping_write_paths"]);
  });
});

describe("topologicalOrder", () => {
  it("orders tasks by dependency", () => {
    const order = topologicalOrder(dag([
      task({ id: "c", dependsOn: ["a", "b"] }),
      task({ id: "a" }),
      task({ id: "b", dependsOn: ["a"] }),
    ]));
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  it("returns null for a cycle", () => {
    assert.equal(topologicalOrder(dag([
      task({ id: "a", dependsOn: ["b"] }),
      task({ id: "b", dependsOn: ["a"] }),
    ])), null);
  });
});

describe("computeTaskTransitions", () => {
  const graph = dag([
    task({ id: "a" }),
    task({ id: "b", dependsOn: ["a"] }),
    task({ id: "c", role: "qa", dependsOn: ["a"], writePaths: [] }),
    task({ id: "d", dependsOn: ["b", "c"] }),
  ]);

  function statuses(map: Record<string, string>): Map<string, RunTaskStatus> {
    return new Map(Object.entries(map) as [string, RunTaskStatus][]);
  }

  it("makes independent tasks ready while dependencies are pending", () => {
    const transitions = computeTaskTransitions(graph, statuses({}));
    assert.deepEqual(transitions.readyTaskIds, ["a"]);
    assert.deepEqual(transitions.blockedTaskIds, []);
  });

  it("makes tasks ready once all dependencies succeeded", () => {
    const transitions = computeTaskTransitions(graph, statuses({ a: "succeeded" }));
    assert.deepEqual(transitions.readyTaskIds, ["b", "c"]);
    assert.deepEqual(transitions.blockedTaskIds, []);
  });

  it("keeps a task pending while any dependency is still running", () => {
    const transitions = computeTaskTransitions(graph, statuses({ a: "succeeded", b: "running" }));
    assert.deepEqual(transitions.readyTaskIds, ["c"]);
    assert.deepEqual(transitions.blockedTaskIds, []);
  });

  it("blocks pending tasks whose dependency failed", () => {
    const transitions = computeTaskTransitions(graph, statuses({ a: "succeeded", b: "failed" }));
    assert.deepEqual(transitions.readyTaskIds, ["c"]);
    assert.deepEqual(transitions.blockedTaskIds, ["d"]);
  });

  it("blocks pending tasks whose dependency was cancelled", () => {
    const transitions = computeTaskTransitions(graph, statuses({ a: "cancelled" }));
    assert.deepEqual(transitions.readyTaskIds, []);
    assert.deepEqual(transitions.blockedTaskIds, ["b", "c"]);
  });

  it("ignores tasks that are no longer pending", () => {
    const transitions = computeTaskTransitions(graph, statuses({
      a: "succeeded",
      b: "succeeded",
      c: "cancelled",
      d: "pending",
    }));
    assert.deepEqual(transitions.readyTaskIds, []);
    assert.deepEqual(transitions.blockedTaskIds, ["d"]);
  });
});
