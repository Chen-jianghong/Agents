/**
 * RunReviewer: reviews a Run's integrated changes with a read-only Reviewer
 * Agent (multi-agent-development-project-plan.md §5.3 / Phase 8).
 *
 * The reviewer receives the merged diff of the Run's succeeded tasks and
 * returns a structured review-report (findings / evidence / recommendations
 * / risks). The host validates the shape; the report is for human review.
 */
import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentProfile, AgentResult, AgentTask } from "./contracts.js";
import type { AgentSessionFactory } from "./manager.js";
import type { ModelGateway } from "./model-gateway.js";
import type { ModelAliases } from "./model-runtime.js";
import type { PiSessionFactoryOptions } from "./pi-adapter.js";
import { extractJsonObject } from "./planner.js";
import { READ_ONLY_TOOLS } from "./tool-policy.js";

export interface ReviewReport {
  findings: string[];
  evidence: string[];
  recommendations: string[];
  risks: string[];
  rawOutput?: string;
}

export type ReviewOutcome =
  | { status: "reviewed"; report: ReviewReport }
  | { status: "review_failed"; reason: { code: string; message: string }; rawOutput?: string };

export interface RunReviewerOptions {
  cwd: string;
  agentDir: string;
  modelProfile?: string;
  model?: NonNullable<PiSessionFactoryOptions["model"]>;
  modelRuntime?: ModelRuntime;
  modelAliases?: ModelAliases;
  modelGateway?: ModelGateway;
  maxTurns?: number;
  timeoutSeconds?: number;
}

export interface ReviewRequest {
  goal: string;
  /** Merged unified diff of the Run's succeeded tasks. */
  diff: string;
  taskSummaries?: Array<{ taskId: string; role: string; status: string }>;
}

export class RunReviewer {
  constructor(
    private readonly sessionFactory: AgentSessionFactory,
    private readonly options: RunReviewerOptions,
  ) {}

  async review(request: ReviewRequest): Promise<ReviewOutcome> {
    if (request.diff.trim().length === 0) {
      return {
        status: "review_failed",
        reason: { code: "no_diff", message: "There are no changes to review" },
      };
    }
    const profile = createReviewerProfile({
      model: this.options.modelProfile ?? "coding-strong",
      ...(this.options.maxTurns !== undefined ? { maxTurns: this.options.maxTurns } : {}),
      ...(this.options.timeoutSeconds !== undefined ? { timeoutSeconds: this.options.timeoutSeconds } : {}),
    });
    const task: AgentTask = {
      id: `reviewer_task_${randomUUID()}`,
      workspace: this.options.cwd,
      task: buildReviewPrompt(request),
      acceptanceCriteria: ["Return a valid review-report JSON document"],
      depth: 0,
    };

    let managed;
    try {
      managed = await this.sessionFactory.create(profile, task, {
        cwd: this.options.cwd,
        agentDir: this.options.agentDir,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.modelRuntime ? { modelRuntime: this.options.modelRuntime } : {}),
        ...(this.options.modelAliases ? { modelAliases: this.options.modelAliases } : {}),
        ...(this.options.modelGateway ? { modelGateway: this.options.modelGateway } : {}),
      });
    } catch (error) {
      return {
        status: "review_failed",
        reason: {
          code: "agent_failed",
          message: `Unable to create the Reviewer session: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }

    const result: AgentResult = await managed.prompt(task);
    if (result.status !== "completed") {
      return {
        status: "review_failed",
        reason: {
          code: "agent_failed",
          message: result.error?.message ?? `Reviewer agent ended with status ${result.status}`,
        },
        ...(result.output ? { rawOutput: result.output } : {}),
      };
    }
    return parseReviewOutput(result.output ?? "");
  }
}

/** Create the read-only Reviewer Agent Profile. */
export function createReviewerProfile(options: {
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
  now?: string;
} = {}): AgentProfile {
  const now = options.now ?? new Date().toISOString();
  return {
    id: "builtin_reviewer",
    name: "reviewer",
    version: 1,
    description: "Reviews a diff and returns a structured review-report.",
    kind: "subagent",
    identity: {
      responsibilities: [
        "Inspect the provided diff for correctness and regression risks",
        "Separate facts from assumptions with file-level evidence",
        "Return a review-report JSON document",
      ],
      nonResponsibilities: [
        "Do not modify project files",
        "Do not approve a change without evidence",
      ],
      systemPrompt: [
        "You are the Reviewer agent.",
        "You review a unified diff without touching any files.",
        "Your entire answer must be the review-report JSON document, optionally wrapped in a ```json code block.",
      ].join("\n"),
    },
    execution: {
      model: options.model ?? "coding-strong",
      thinkingLevel: "high",
      tools: [...READ_ONLY_TOOLS],
      readOnly: true,
      writePaths: [],
      canDelegate: false,
      maxDepth: 0,
    },
    output: {
      format: "json",
      schemaName: "review-report",
      requiredSections: [],
      requiredFields: ["findings", "evidence", "recommendations", "risks"],
      acceptanceCriteriaRequired: true,
      reportChangedFiles: false,
      reportTests: false,
      reportRisks: true,
    },
    limits: {
      maxTurns: options.maxTurns ?? 5,
      timeoutSeconds: options.timeoutSeconds ?? 600,
      maxConcurrentChildren: 0,
    },
    context: {
      includeParentSummary: true,
      includeTaskFiles: [],
      loadProjectInstructions: true,
      memoryMode: "read",
    },
    lifecycle: {
      persistence: "ephemeral",
      scope: "run",
      createdBy: "system",
      createdAt: now,
    },
  };
}

export function buildReviewPrompt(request: ReviewRequest): string {
  const tasks = request.taskSummaries?.length
    ? request.taskSummaries.map((t) => `- ${t.taskId} (${t.role}, ${t.status})`).join("\n")
    : "- (no task summary provided)";
  return [
    "## Goal",
    request.goal,
    "",
    "## Tasks in this change",
    tasks,
    "",
    "## Diff to review",
    "```diff",
    request.diff,
    "```",
    "",
    "## Output contract",
    "Produce exactly one JSON document:",
    JSON.stringify({
      findings: ["array of strings: problems, risks or observations"],
      evidence: ["array of strings: file-level evidence for each finding"],
      recommendations: ["array of strings: actionable suggestions"],
      risks: ["array of strings: remaining risks after the change"],
    }, null, 2),
    "",
    "## Constraints",
    "- Be specific and cite file paths/lines from the diff.",
    "- Do not modify any files; you are read-only.",
    "- Do not emit anything other than the JSON document.",
  ].join("\n");
}

/** Parse and normalize the Reviewer output into a ReviewOutcome. */
export function parseReviewOutput(rawOutput: string): ReviewOutcome {
  const json = extractJsonObject(rawOutput);
  if (json === undefined) {
    return {
      status: "review_failed",
      reason: { code: "invalid_json", message: "Reviewer output did not contain a JSON object" },
      rawOutput,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      status: "review_failed",
      reason: {
        code: "invalid_json",
        message: `Reviewer output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
      rawOutput,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      status: "review_failed",
      reason: { code: "invalid_json", message: "Reviewer output is not an object" },
      rawOutput,
    };
  }
  const report = parsed as Record<string, unknown>;
  const reportValue: ReviewReport = {
    findings: toStringArray(report.findings),
    evidence: toStringArray(report.evidence),
    recommendations: toStringArray(report.recommendations),
    risks: toStringArray(report.risks),
    rawOutput,
  };
  return { status: "reviewed", report: reportValue };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
