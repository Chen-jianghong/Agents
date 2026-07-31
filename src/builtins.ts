import type { AgentProfile, AgentExecutionPolicy, OutputContract, ThinkingLevel, ToolName } from "./contracts.js";
import { CODING_TOOLS, READ_ONLY_TOOLS } from "./tool-policy.js";

export function createBuiltInProfiles(now = new Date().toISOString()): AgentProfile[] {
  return [
    createBuiltInProfile({
      name: "researcher",
      description: "Reads code and documentation and returns evidence-backed findings.",
      responsibilities: ["Inspect code and documentation", "Trace relevant modules", "Separate facts from assumptions"],
      nonResponsibilities: ["Do not modify project files", "Do not run destructive commands"],
      tools: [...READ_ONLY_TOOLS],
      readOnly: true,
      canDelegate: false,
      model: "coding-balanced",
      thinkingLevel: "high",
      output: reportContract("research-report", ["findings", "evidence", "recommendations"]),
      now,
    }),
    createBuiltInProfile({
      name: "coder",
      description: "Implements an approved coding task inside the task write boundary.",
      responsibilities: ["Read the existing implementation", "Make the smallest correct change", "Run relevant tests"],
      nonResponsibilities: ["Do not change files outside the assigned task boundary", "Do not deploy"],
      tools: [...CODING_TOOLS],
      readOnly: false,
      writePaths: ["."],
      canDelegate: false,
      model: "coding-balanced",
      thinkingLevel: "high",
      output: reportContract("implementation-report", ["summary", "changedFiles", "tests"]),
      now,
    }),
    createBuiltInProfile({
      name: "tester",
      description: "Runs focused verification and reports failures and regressions.",
      responsibilities: ["Run the requested test commands", "Reproduce failures", "Report evidence and remaining risks"],
      nonResponsibilities: ["Do not silently change production code"],
      tools: ["read", "grep", "find", "ls", "bash"],
      readOnly: false,
      writePaths: ["."],
      canDelegate: false,
      model: "coding-balanced",
      thinkingLevel: "medium",
      output: reportContract("test-report", ["tests", "failures", "risks"]),
      now,
    }),
    createBuiltInProfile({
      name: "reviewer",
      description: "Reviews changes without modifying the workspace.",
      responsibilities: ["Inspect the diff", "Find correctness and regression risks", "Report evidence and recommendations"],
      nonResponsibilities: ["Do not modify files", "Do not approve a change without evidence"],
      tools: [...READ_ONLY_TOOLS],
      readOnly: true,
      canDelegate: false,
      model: "coding-strong",
      thinkingLevel: "high",
      output: reportContract("review-report", ["findings", "evidence", "risks"]),
      now,
    }),
  ];
}

interface BuiltInProfileOptions {
  name: string;
  description: string;
  responsibilities: string[];
  nonResponsibilities: string[];
  tools: ToolName[];
  readOnly: boolean;
  writePaths?: string[];
  canDelegate: boolean;
  model: string;
  thinkingLevel: ThinkingLevel;
  output: OutputContract;
  now: string;
}

function createBuiltInProfile(options: BuiltInProfileOptions): AgentProfile {
  const execution: AgentExecutionPolicy = {
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    tools: options.tools,
    readOnly: options.readOnly,
    writePaths: options.writePaths ?? [],
    canDelegate: options.canDelegate,
    maxDepth: 1,
  };

  return {
    id: `builtin_${options.name}`,
    name: options.name,
    version: 1,
    description: options.description,
    kind: "subagent",
    identity: {
      responsibilities: options.responsibilities,
      nonResponsibilities: options.nonResponsibilities,
      systemPrompt: buildSystemPrompt(options, execution),
    },
    execution,
    output: options.output,
    limits: {
      maxTurns: 30,
      timeoutSeconds: 1800,
      maxConcurrentChildren: 0,
    },
    context: {
      includeParentSummary: true,
      includeTaskFiles: [],
      loadProjectInstructions: true,
      memoryMode: "read",
    },
    lifecycle: {
      persistence: "persistent",
      scope: "project",
      createdBy: "system",
      createdAt: options.now,
    },
  };
}

function reportContract(schemaName: string, requiredFields: string[]): OutputContract {
  return {
    format: "json",
    schemaName,
    requiredSections: [],
    requiredFields,
    acceptanceCriteriaRequired: true,
    reportChangedFiles: schemaName === "implementation-report",
    reportTests: true,
    reportRisks: true,
  };
}

function buildSystemPrompt(options: BuiltInProfileOptions, execution: AgentExecutionPolicy): string {
  return [
    `You are the ${options.name} agent.`,
    "",
    "Responsibilities:",
    ...options.responsibilities.map((item) => `- ${item}`),
    "",
    "Non-responsibilities:",
    ...options.nonResponsibilities.map((item) => `- ${item}`),
    "",
    `Effective tools: ${execution.tools.join(", ")}`,
    `Read only: ${execution.readOnly ? "yes" : "no"}`,
    "The host runtime is the authority for tools, paths, and approvals.",
  ].join("\n");
}
