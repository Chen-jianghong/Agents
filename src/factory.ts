import { randomUUID } from "node:crypto";
import type {
  AgentExecutionPolicy,
  AgentProfile,
  AgentTask,
  CreateAgentRequest,
  EffectiveProfileResult,
  ToolName,
} from "./contracts.js";
import { intersectTools, normalizePaths, restrictWritePaths, READ_ONLY_TOOLS } from "./tool-policy.js";
import { defaultOutputContract, validateCreateRequest } from "./profile-validator.js";
import type { ProfileRegistry } from "./registry.js";

export interface FactoryPolicy {
  defaultModel: string;
  defaultThinkingLevel: AgentProfile["execution"]["thinkingLevel"];
  maxDepth: number;
  maxTurns: number;
  timeoutSeconds: number;
  allowedTools: readonly ToolName[];
  allowPersistentProfiles: boolean;
}

export const DEFAULT_FACTORY_POLICY: FactoryPolicy = {
  defaultModel: "coding-balanced",
  defaultThinkingLevel: "medium",
  maxDepth: 1,
  maxTurns: 30,
  timeoutSeconds: 1800,
  allowedTools: [...READ_ONLY_TOOLS, "write", "edit", "bash"],
  allowPersistentProfiles: false,
};

export class AgentFactory {
  constructor(
    private readonly registry: ProfileRegistry,
    private readonly policy: FactoryPolicy = DEFAULT_FACTORY_POLICY,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Create the host-only variant used after an explicit persistence approval.
   * The regular factory intentionally remains unable to create persistent
   * profiles, including when it is exposed to the Main Agent.
   */
  withPersistentProfiles(): AgentFactory {
    return new AgentFactory(
      this.registry,
      { ...this.policy, allowPersistentProfiles: true },
      this.now,
    );
  }

  get maxDepth(): number {
    return this.policy.maxDepth;
  }

  createProfile(request: CreateAgentRequest, task: AgentTask): EffectiveProfileResult {
    validateCreateRequest(request);

    const warnings: string[] = [];
    const requestedTools = request.requestedTools ?? [...READ_ONLY_TOOLS];
    let effectiveTools = intersectTools(requestedTools, this.policy.allowedTools);

    for (const tool of requestedTools) {
      if (!effectiveTools.includes(tool)) warnings.push(`requested tool ${tool} was removed by runtime policy`);
    }

    const readOnly = request.readOnly ?? true;
    if (readOnly) {
      const before = effectiveTools.length;
      effectiveTools = effectiveTools.filter((tool) => READ_ONLY_TOOLS.includes(tool));
      if (before !== effectiveTools.length) warnings.push("mutation tools were removed because readOnly=true");
    }

    const persistence = request.persistence ?? "ephemeral";
    if (persistence === "persistent" && !this.policy.allowPersistentProfiles) {
      throw new Error("persistent profiles require explicit user approval");
    }

    if (task.depth > this.policy.maxDepth) {
      throw new Error(`agent depth ${task.depth} exceeds maximum ${this.policy.maxDepth}`);
    }

    const writePaths = readOnly
      ? []
      : restrictWritePaths(request.requestedWritePaths ?? [], task.writePaths ?? [], task.workspace);

    if (!readOnly && (request.requestedWritePaths?.length ?? 0) > 0 && writePaths.length === 0) {
      warnings.push("requested write paths were removed because they are outside the task boundary");
    }

    const canDelegate = request.canDelegate === true && task.depth < this.policy.maxDepth;
    if (request.canDelegate === true && !canDelegate) {
      warnings.push("delegation was disabled because the maximum depth was reached");
    }

    const execution: AgentExecutionPolicy = {
      model: request.requestedModel ?? this.policy.defaultModel,
      thinkingLevel: request.thinkingLevel ?? this.policy.defaultThinkingLevel,
      tools: effectiveTools,
      readOnly,
      writePaths: normalizePaths(writePaths),
      canDelegate,
      maxDepth: this.policy.maxDepth,
    };

    const profile: AgentProfile = {
      id: `agent_${randomUUID()}`,
      name: request.name,
      version: 1,
      description: request.description,
      kind: "subagent",
      identity: {
        responsibilities: [...request.responsibilities],
        nonResponsibilities: [...(request.nonResponsibilities ?? [])],
        systemPrompt: request.systemPrompt ?? buildDefaultSystemPrompt(request, execution),
      },
      execution,
      output: defaultOutputContract(request.outputContract),
      limits: {
        maxTurns: this.policy.maxTurns,
        timeoutSeconds: this.policy.timeoutSeconds,
        maxConcurrentChildren: 0,
      },
      context: {
        includeParentSummary: true,
        includeTaskFiles: task.files ?? [],
        loadProjectInstructions: true,
        memoryMode: "read",
      },
      lifecycle: {
        persistence,
        scope: request.scope ?? "task",
        createdBy: request.createdBy,
        createdAt: this.now(),
      },
    };

    const registered = this.registry.register(profile);
    return { profile: registered, warnings };
  }

  bindProfile(profile: AgentProfile, task: AgentTask): EffectiveProfileResult {
    if (task.depth > this.policy.maxDepth) {
      throw new Error(`agent depth ${task.depth} exceeds maximum ${this.policy.maxDepth}`);
    }
    const warnings: string[] = [];
    const writePaths = profile.execution.readOnly
      ? []
      : restrictWritePaths(profile.execution.writePaths, task.writePaths ?? [], task.workspace);

    if (!profile.execution.readOnly && profile.execution.writePaths.length > 0 && writePaths.length === 0) {
      warnings.push("profile write paths do not overlap the task boundary; no writes are allowed");
    }

    const maxDepth = Math.min(profile.execution.maxDepth, this.policy.maxDepth);
    const canDelegate = profile.execution.canDelegate && task.depth < maxDepth;
    if (profile.execution.canDelegate && !canDelegate) {
      warnings.push("delegation was disabled for this task because the maximum depth was reached");
    }

    return {
      profile: structuredClone({
        ...profile,
        execution: {
          ...profile.execution,
          writePaths,
          maxDepth,
          canDelegate,
        },
        context: {
          ...profile.context,
          includeTaskFiles: task.files ?? profile.context.includeTaskFiles,
        },
      }),
      warnings,
    };
  }
}

function buildDefaultSystemPrompt(request: CreateAgentRequest, execution: AgentExecutionPolicy): string {
  const responsibilities = request.responsibilities.map((item) => `- ${item}`).join("\n");
  const nonResponsibilities = (request.nonResponsibilities ?? []).map((item) => `- ${item}`).join("\n") || "- None specified";
  return [
    `You are the ${request.name} agent.`,
    "",
    "Responsibilities:",
    responsibilities,
    "",
    "Non-responsibilities:",
    nonResponsibilities,
    "",
    `Effective tools: ${execution.tools.join(", ") || "none"}`,
    `Read only: ${execution.readOnly ? "yes" : "no"}`,
    `Write paths: ${execution.writePaths.join(", ") || "none"}`,
    `Can delegate: ${execution.canDelegate ? "yes" : "no"}`,
    "",
    "Follow the task acceptance criteria and report evidence, tests, changed files, and remaining risks.",
  ].join("\n");
}
