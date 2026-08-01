import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiSessionFactory, RunIntegrator } from "../src/index.js";
import { RunReviewer, parseReviewOutput } from "../src/run-reviewer.js";
import type { RunSnapshot, RunTaskSnapshot } from "../src/plan-contracts.js";

const execFile = promisify(execFileCallback);

const VALID_REPORT = {
  findings: ["Missing error handling in the new endpoint"],
  evidence: ["server/modules/members/route.ts:12"],
  recommendations: ["Wrap the handler in try/catch"],
  risks: ["The change is not covered by tests"],
};

describe("parseReviewOutput", () => {
  it("parses a plain JSON review-report", () => {
    const outcome = parseReviewOutput(JSON.stringify(VALID_REPORT));
    assert.equal(outcome.status, "reviewed");
    if (outcome.status !== "reviewed") return;
    assert.equal(outcome.report.findings[0], "Missing error handling in the new endpoint");
    assert.equal(outcome.report.evidence[0], "server/modules/members/route.ts:12");
    assert.equal(outcome.report.risks.length, 1);
  });

  it("parses a fenced JSON review-report", () => {
    const outcome = parseReviewOutput(`Review:\n\`\`\`json\n${JSON.stringify(VALID_REPORT)}\n\`\`\``);
    assert.equal(outcome.status, "reviewed");
  });

  it("fails on non-JSON output", () => {
    const outcome = parseReviewOutput("This diff looks fine overall.");
    assert.equal(outcome.status, "review_failed");
    if (outcome.status !== "review_failed") return;
    assert.equal(outcome.reason.code, "invalid_json");
  });
});

describe("RunReviewer", () => {
  it("reviews a diff through a real Pi Reviewer session", async () => {
    const faux = fauxProvider({ provider: "faux-review", models: [{ id: "faux-model", reasoning: false }] });
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const aliases = { "coding-strong": "faux-review/faux-model" };
    const agentDir = join(tmpdir(), "reviewer-test");
    try {
      faux.setResponses([fauxAssistantMessage(JSON.stringify(VALID_REPORT))]);

      const reviewer = new RunReviewer(new PiSessionFactory(), {
        cwd: process.cwd(),
        agentDir,
        modelRuntime,
        modelAliases: aliases,
      });
      const outcome = await reviewer.review({
        goal: "Implement members management",
        diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n init\n+added\n",
      });

      assert.equal(outcome.status, "reviewed");
      if (outcome.status !== "reviewed") return;
      assert.ok(outcome.report.findings.length > 0);
      assert.equal(faux.state.callCount, 1);
    } finally {
      // faux providers are test-local; no unregister API.
    }
  });

  it("rejects an empty diff", async () => {
    const reviewer = new RunReviewer({ create: async () => { throw new Error("unreachable"); } }, {
      cwd: process.cwd(),
      agentDir: join(tmpdir(), "reviewer-empty"),
    });
    const outcome = await reviewer.review({ goal: "g", diff: "  " });
    assert.equal(outcome.status, "review_failed");
    if (outcome.status !== "review_failed") return;
    assert.equal(outcome.reason.code, "no_diff");
  });
});

describe("RunIntegrator.merge", () => {
  function runSnapshot(runId: string, repository: string): RunSnapshot {
    const tasks: RunTaskSnapshot[] = [];
    return {
      runId,
      status: "succeeded",
      goal: "g",
      workspace: repository,
      maxParallel: 1,
      tasks,
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    };
  }

  it("merges the integration branch into the default branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrator-merge-"));
    const repository = join(root, "repository");
    await mkdir(repository, { recursive: true });
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFile = promisify(execFileCb);
    await execFile("git", ["init", repository]);
    await execFile("git", ["-C", repository, "config", "user.email", "t@e.c"]);
    await execFile("git", ["-C", repository, "config", "user.name", "T"]);
    await execFile("git", ["-C", repository, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await (await import("node:fs/promises")).writeFile(join(repository, "README.md"), "init\n", "utf8");
    await execFile("git", ["-C", repository, "add", "."]);
    await execFile("git", ["-C", repository, "commit", "-m", "base"]);

    const integrator = new RunIntegrator({ workspace: repository });
    // Create an integration branch with one committed change.
    await execFile("git", ["-C", repository, "checkout", "-b", "integration/run_m1"]);
    await (await import("node:fs/promises")).writeFile(join(repository, "m1.txt"), "m1\n", "utf8");
    await execFile("git", ["-C", repository, "add", "."]);
    await execFile("git", ["-C", repository, "commit", "-m", "task m1"]);
    await execFile("git", ["-C", repository, "checkout", "main"]);

    const report = await integrator.merge("run_m1");
    assert.equal(report.status, "merged");
    assert.equal(report.branch, "integration/run_m1");
    // The change is now on main.
    const content = await (await import("node:fs/promises")).readFile(join(repository, "m1.txt"), "utf8");
    assert.equal(content.trim(), "m1");
    await rm(root, { recursive: true, force: true });
  });

  it("returns not_found when the integration branch is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "integrator-merge-missing-"));
    const repository = join(root, "repository");
    await mkdir(repository, { recursive: true });
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFile = promisify(execFileCb);
    await execFile("git", ["init", repository]);
    await execFile("git", ["-C", repository, "symbolic-ref", "HEAD", "refs/heads/main"]);

    const integrator = new RunIntegrator({ workspace: repository });
    const report = await integrator.merge("run_missing");
    assert.equal(report.status, "not_found");
    await rm(root, { recursive: true, force: true });
  });
});
