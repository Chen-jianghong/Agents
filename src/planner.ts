/**
 * Planner: converts a natural-language goal into a validated TaskDAG.
 *
 * The Planner is a read-only Pi Agent whose prompt asks for a structured
 * JSON plan. The host parses the raw output, extracts JSON (tolerating
 * markdown fences) and validates it with validateDAG. Invalid output never
 * reaches the scheduler: the Run enters PLANNING_FAILED (see
 * multi-agent-development-project-plan.md §6 "Planner 输出不符合 Schema 时，
 * Run 进入 PLANNING_FAILED").
 */
import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentProfile, AgentResult, AgentTask } from "./contracts.js";
import { validateDAG } from "./dag.js";
import type { ModelGateway } from "./model-gateway.js";
import type { ModelAliases } from "./model-runtime.js";
import type { PlanOutcome, PlanTask, TaskDAG } from "./plan-contracts.js";
import type { AgentSessionFactory } from "./manager.js";
import type { PiSessionFactoryOptions } from "./pi-adapter.js";
import { READ_ONLY_TOOLS } from "./tool-policy.js";

/** Host-visible contract of a Planner, injectable for tests. */
export interface PlanPlanner {
  plan(goal: string): Promise<PlanOutcome>;
}

export interface PlannerServiceOptions {
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

export class PlannerService implements PlanPlanner {
  constructor(
    private readonly sessionFactory: AgentSessionFactory,
    private readonly options: PlannerServiceOptions,
  ) {}

  async plan(goal: string): Promise<PlanOutcome> {
    const profile = createPlannerProfile({
      model: this.options.modelProfile ?? "coding-strong",
      ...(this.options.maxTurns !== undefined ? { maxTurns: this.options.maxTurns } : {}),
      ...(this.options.timeoutSeconds !== undefined ? { timeoutSeconds: this.options.timeoutSeconds } : {}),
    });
    const task: AgentTask = {
      id: `planner_task_${randomUUID()}`,
      workspace: this.options.cwd,
      task: buildPlannerPrompt(goal),
      acceptanceCriteria: ["Return a valid TaskDAG JSON document"],
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
        status: "planning_failed",
        reason: {
          code: "agent_failed",
          message: `Unable to create the Planner session: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }

    const result: AgentResult = await managed.prompt(task);
    if (result.status !== "completed") {
      return {
        status: "planning_failed",
        reason: {
          code: "agent_failed",
          message: result.error?.message ?? `Planner agent ended with status ${result.status}`,
        },
        ...(result.output ? { rawOutput: result.output } : {}),
      };
    }

    return parsePlanOutput(result.output ?? "");
  }
}

/** Parse and validate the raw Planner output into a PlanOutcome. */
export function parsePlanOutput(rawOutput: string): PlanOutcome {
  const json = extractJsonObject(rawOutput);
  if (json === undefined) {
    return {
      status: "planning_failed",
      reason: { code: "invalid_json", message: "Planner output did not contain a JSON object" },
      rawOutput,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      status: "planning_failed",
      reason: {
        code: "invalid_json",
        message: `Planner output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
      rawOutput,
    };
  }

  const dag = normalizeDAG(parsed);
  if (dag === undefined) {
    return {
      status: "planning_failed",
      reason: { code: "invalid_json", message: "Planner output is not a TaskDAG object with a goal and a tasks array" },
      rawOutput,
    };
  }

  const validation = validateDAG(dag);
  if (!validation.valid) {
    return {
      status: "planning_failed",
      reason: { code: "invalid_dag", issues: validation.issues },
      rawOutput,
    };
  }

  return { status: "planned", dag, validation, rawOutput };
}

/**
 * Create the Planner Agent Profile. Read-only: it may inspect the project,
 * but must never modify business code; its only output is the DAG JSON.
 */
export function createPlannerProfile(options: {
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
  now?: string;
} = {}): AgentProfile {
  const now = options.now ?? new Date().toISOString();
  return {
    id: "builtin_planner",
    name: "planner",
    version: 1,
    description: "Breaks a natural-language goal into a validated, parallelizable TaskDAG.",
    kind: "subagent",
    identity: {
      responsibilities: [
        "Analyze the goal and the project structure",
        "Break the goal into small parallelizable tasks with clear boundaries",
        "Assign every task a role, dependencies, write paths, acceptance criteria and test commands",
        "Return exactly one valid TaskDAG JSON document",
      ],
      nonResponsibilities: [
        "Do not modify project files",
        "Do not return prose instead of the DAG schema",
        "Do not invent dependencies that cannot be satisfied",
      ],
      systemPrompt: [
        "You are the Planner agent.",
        "You convert a natural-language development request into a structured TaskDAG.",
        "You may inspect the project with read-only tools, but you never change files.",
        "Your entire answer must be the DAG JSON document, optionally wrapped in a ```json code block.",
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
      schemaName: "task-dag",
      requiredSections: [],
      requiredFields: ["goal", "tasks"],
      acceptanceCriteriaRequired: true,
      reportChangedFiles: false,
      reportTests: false,
      reportRisks: false,
    },
    limits: {
      maxTurns: options.maxTurns ?? 5,
      timeoutSeconds: options.timeoutSeconds ?? 600,
      maxConcurrentChildren: 0,
    },
    context: {
      includeParentSummary: false,
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

/** Build the Planner prompt that asks for a TaskDAG conforming to our schema. */
export function buildPlannerPrompt(goal: string): string {
  return [
    "## Goal",
    goal,
    "",
    "## Output contract",
    "Produce exactly one JSON document describing a TaskDAG. You may wrap it in a ```json code block.",
    "Schema:",
    JSON.stringify({
      goal: "string",
      tasks: [
        {
          id: "unique lowercase id within this run",
          title: "short actionable title",
          role: "backend | frontend | qa | reviewer | researcher | docs | devops",
          dependsOn: ["ids of tasks that must succeed first"],
          modelProfile: "optional model profile name",
          writePaths: ["workspace-relative directories this task may modify (empty for read-only)"],
          acceptanceCriteria: ["verifiable criteria"],
          testCommands: ["commands to verify the task"],
        },
      ],
    }, null, 2),
    "",
    "## Constraints",
    "- task ids must be unique; dependsOn may only reference existing ids and must not form a cycle.",
    "- Writable tasks (non-empty writePaths) must not have overlapping write paths; use \".\" only for a task that owns the whole workspace.",
    "- Every task must have non-empty acceptanceCriteria.",
    "- Parallelize independent work; only add dependsOn where a real ordering requirement exists.",
    "- Do not emit anything other than the JSON document.",
  ].join("\n");
}

/** Extract the first JSON object from a model response (tolerating fences). */
export function extractJsonObject(output: string): string | undefined {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : output;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
}

function normalizeDAG(value: unknown): TaskDAG | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.goal !== "string" || !Array.isArray(raw.tasks)) return undefined;

  const tasks: PlanTask[] = [];
  for (const rawTask of raw.tasks) {
    if (typeof rawTask !== "object" || rawTask === null) return undefined;
    const t = rawTask as Record<string, unknown>;
    if (typeof t.id !== "string" || typeof t.title !== "string" || typeof t.role !== "string") return undefined;
    tasks.push({
      id: t.id,
      title: t.title,
      role: t.role,
      dependsOn: toStringArray(t.dependsOn),
      ...(typeof t.modelProfile === "string" ? { modelProfile: t.modelProfile } : {}),
      writePaths: toStringArray(t.writePaths),
      acceptanceCriteria: toStringArray(t.acceptanceCriteria),
      testCommands: toStringArray(t.testCommands),
    });
  }
  return { goal: raw.goal, tasks };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
