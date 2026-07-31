import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePlanOutput } from "../src/planner.js";

const VALID_DAG = {
  goal: "Implement members management",
  tasks: [
    {
      id: "backend",
      title: "Implement members API",
      role: "backend",
      dependsOn: [],
      writePaths: ["server/modules/members"],
      acceptanceCriteria: ["implement the list endpoint"],
      testCommands: ["npm test -- members"],
    },
    {
      id: "frontend",
      title: "Implement members page",
      role: "frontend",
      dependsOn: ["backend"],
      writePaths: ["web/src/pages/members"],
      acceptanceCriteria: ["show the member list"],
      testCommands: ["npm test -- members-page"],
    },
  ],
};

describe("parsePlanOutput", () => {
  it("parses a plain JSON TaskDAG", () => {
    const outcome = parsePlanOutput(JSON.stringify(VALID_DAG));
    assert.equal(outcome.status, "planned");
    if (outcome.status !== "planned") return;
    assert.equal(outcome.dag.goal, "Implement members management");
    assert.equal(outcome.dag.tasks.length, 2);
    assert.equal(outcome.validation.valid, true);
    assert.deepEqual(outcome.validation.topoOrder, ["backend", "frontend"]);
  });

  it("parses a TaskDAG wrapped in a fenced code block", () => {
    const outcome = parsePlanOutput("Here is the plan:\n```json\n" + JSON.stringify(VALID_DAG) + "\n```\n");
    assert.equal(outcome.status, "planned");
  });

  it("parses a TaskDAG wrapped in a plain code block", () => {
    const outcome = parsePlanOutput("```\n" + JSON.stringify(VALID_DAG) + "\n```");
    assert.equal(outcome.status, "planned");
  });

  it("tolerates surrounding prose before and after the JSON", () => {
    const outcome = parsePlanOutput(`Analysis: this needs two tasks.\n${JSON.stringify(VALID_DAG)}\nDone.`);
    assert.equal(outcome.status, "planned");
  });

  it("rejects output without a JSON object", () => {
    const outcome = parsePlanOutput("I think we should split this into two tasks.");
    assert.equal(outcome.status, "planning_failed");
    if (outcome.status !== "planning_failed") return;
    assert.equal(outcome.reason.code, "invalid_json");
  });

  it("rejects malformed JSON", () => {
    const outcome = parsePlanOutput('{"goal": "x", "tasks": [}');
    assert.equal(outcome.status, "planning_failed");
    if (outcome.status !== "planning_failed") return;
    assert.equal(outcome.reason.code, "invalid_json");
  });

  it("rejects a JSON value that is not a TaskDAG", () => {
    const outcome = parsePlanOutput(JSON.stringify({ hello: "world" }));
    assert.equal(outcome.status, "planning_failed");
    if (outcome.status !== "planning_failed") return;
    assert.equal(outcome.reason.code, "invalid_json");
  });

  it("rejects a DAG with validation issues", () => {
    const cyclic = {
      goal: "x",
      tasks: [
        { id: "a", title: "A", role: "backend", dependsOn: ["b"], writePaths: ["a"], acceptanceCriteria: ["a"] },
        { id: "b", title: "B", role: "backend", dependsOn: ["a"], writePaths: ["b"], acceptanceCriteria: ["b"] },
      ],
    };
    const outcome = parsePlanOutput(JSON.stringify(cyclic));
    assert.equal(outcome.status, "planning_failed");
    if (outcome.status !== "planning_failed") return;
    assert.equal(outcome.reason.code, "invalid_dag");
    assert.ok((outcome.reason as { issues: { code: string }[] }).issues.some((issue) => issue.code === "cyclic_dependency"));
  });

  it("normalizes missing optional arrays to empty arrays", () => {
    const minimal = {
      goal: "x",
      tasks: [{ id: "a", title: "A", role: "backend", acceptanceCriteria: ["a"] }],
    };
    const outcome = parsePlanOutput(JSON.stringify(minimal));
    assert.equal(outcome.status, "planned");
    if (outcome.status !== "planned") return;
    assert.deepEqual(outcome.dag.tasks[0]?.dependsOn, []);
    assert.deepEqual(outcome.dag.tasks[0]?.writePaths, []);
    assert.deepEqual(outcome.dag.tasks[0]?.testCommands, []);
  });
});
