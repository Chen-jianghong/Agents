import type {
  AgentProfile,
  CreateAgentRequest,
  OutputContract,
  ToolName,
} from "./contracts.js";

const VALID_TOOLS = new Set<ToolName>([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "create_agent",
  "spawn_agent",
  "delegate",
  "list_agents",
  "get_agent_result",
  "cancel_agent",
]);

const RESERVED_NAMES = new Set(["main", "system", "admin"]);
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class ProfileValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid agent profile: ${issues.join("; ")}`);
    this.name = "ProfileValidationError";
    this.issues = issues;
  }
}

export function validateProfileName(name: string): void {
  const issues: string[] = [];
  if (!NAME_PATTERN.test(name)) {
    issues.push("name must match /^[a-z0-9][a-z0-9_-]{0,63}$/");
  }
  if (RESERVED_NAMES.has(name)) {
    issues.push(`name ${name} is reserved`);
  }
  if (issues.length > 0) {
    throw new ProfileValidationError(issues);
  }
}

export function validateCreateRequest(request: CreateAgentRequest): void {
  const issues: string[] = [];

  try {
    validateProfileName(request.name);
  } catch (error) {
    if (error instanceof ProfileValidationError) {
      issues.push(...error.issues);
    } else {
      throw error;
    }
  }

  if (request.description.trim().length === 0) issues.push("description is required");
  if (request.responsibilities.length === 0) issues.push("at least one responsibility is required");
  if (request.reason.trim().length === 0) issues.push("reason is required");

  for (const tool of request.requestedTools ?? []) {
    if (!VALID_TOOLS.has(tool)) issues.push(`unknown tool: ${tool}`);
  }

  if (request.persistence === "persistent" && request.scope !== "project" && request.scope !== "user") {
    issues.push("persistent profiles must use project or user scope");
  }

  if (request.readOnly && (request.requestedWritePaths?.length ?? 0) > 0) {
    issues.push("read-only profiles cannot request write paths");
  }

  if (issues.length > 0) {
    throw new ProfileValidationError(issues);
  }
}

export function validateProfile(profile: AgentProfile): void {
  validateProfileName(profile.name);
  const issues: string[] = [];

  if (profile.version < 1 || !Number.isInteger(profile.version)) issues.push("version must be a positive integer");
  if (profile.identity.responsibilities.length === 0) issues.push("responsibilities cannot be empty");
  if (profile.execution.readOnly && profile.execution.writePaths.length > 0) issues.push("read-only profile cannot have write paths");
  if (profile.execution.readOnly && profile.execution.tools.some((tool) => tool === "write" || tool === "edit" || tool === "bash")) {
    issues.push("read-only profile cannot have mutation tools");
  }
  if (profile.limits.maxTurns < 1) issues.push("maxTurns must be positive");
  if (profile.limits.timeoutSeconds < 1) issues.push("timeoutSeconds must be positive");
  if (
    profile.limits.maxCostUsd !== undefined
    && (!Number.isFinite(profile.limits.maxCostUsd) || profile.limits.maxCostUsd < 0)
  ) {
    issues.push("maxCostUsd must be a finite non-negative number");
  }
  if (profile.limits.maxConcurrentChildren < 0) issues.push("maxConcurrentChildren cannot be negative");

  if (issues.length > 0) throw new ProfileValidationError(issues);
}

export function defaultOutputContract(overrides: Partial<OutputContract> = {}): OutputContract {
  return {
    format: "text",
    requiredSections: [],
    requiredFields: [],
    acceptanceCriteriaRequired: true,
    reportChangedFiles: true,
    reportTests: true,
    reportRisks: true,
    ...overrides,
  };
}
