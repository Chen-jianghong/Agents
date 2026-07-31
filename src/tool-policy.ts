import { resolve, relative, isAbsolute } from "node:path";
import type {
  AgentProfile,
  AuthorizationResult,
  ToolAuthorizationContext,
  ToolName,
} from "./contracts.js";

export const READ_ONLY_TOOLS: readonly ToolName[] = [
  "read",
  "grep",
  "find",
  "ls",
];

export const CODING_TOOLS: readonly ToolName[] = [
  ...READ_ONLY_TOOLS,
  "write",
  "edit",
  "bash",
];

export const ORCHESTRATION_TOOLS: readonly ToolName[] = [
  "create_agent",
  "spawn_agent",
  "delegate",
  "list_agents",
  "get_agent_result",
  "cancel_agent",
];

const MUTATION_TOOLS = new Set<ToolName>(["write", "edit", "bash"]);

export function intersectTools(
  requested: readonly ToolName[],
  allowed: readonly ToolName[],
): ToolName[] {
  const allowedSet = new Set(allowed);
  return [...new Set(requested)].filter((tool) => allowedSet.has(tool));
}

export function isMutationTool(tool: ToolName): boolean {
  return MUTATION_TOOLS.has(tool);
}

export function isPathInside(root: string, candidate: string): boolean {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(root, candidate);
  const relativePath = relative(absoluteRoot, absoluteCandidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function normalizePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

export function restrictWritePaths(
  requested: readonly string[],
  taskPaths: readonly string[],
  workspace: string,
): string[] {
  const normalizedRequested = normalizePaths(requested);
  const normalizedTaskPaths = normalizePaths(taskPaths);

  if (normalizedTaskPaths.length === 0) {
    return [];
  }

  const result: string[] = [];
  for (const requestedPath of normalizedRequested) {
    const absoluteRequested = resolve(workspace, requestedPath);
    for (const taskPath of normalizedTaskPaths) {
      const absoluteTask = resolve(workspace, taskPath);
      if (isAbsolutePathInside(absoluteRequested, absoluteTask)) {
        // The requested boundary is broader; keep the narrower task boundary.
        result.push(taskPath);
      } else if (isAbsolutePathInside(absoluteTask, absoluteRequested)) {
        result.push(requestedPath);
      }
    }
  }
  return normalizePaths(result);
}

export function authorizeTool(
  context: ToolAuthorizationContext,
  tool: ToolName,
  args: unknown,
): AuthorizationResult {
  const { profile, workspace } = context;

  if (!profile.execution.tools.includes(tool)) {
    return { allowed: false, reason: "tool_not_granted" };
  }

  if (profile.execution.readOnly && isMutationTool(tool)) {
    return { allowed: false, reason: "read_only_profile" };
  }

  if (tool === "create_agent" || tool === "spawn_agent" || tool === "delegate") {
    if (!profile.execution.canDelegate) {
      return { allowed: false, reason: "delegation_not_granted" };
    }
  }

  if ((tool === "write" || tool === "edit") && !hasAllowedPath(args, profile.execution.writePaths, workspace)) {
    return { allowed: false, reason: "path_outside_profile_boundary" };
  }

  return { allowed: true };
}

function hasAllowedPath(args: unknown, allowedPaths: readonly string[], workspace: string): boolean {
  if (allowedPaths.length === 0 || typeof args !== "object" || args === null) {
    return false;
  }

  const value = args as Record<string, unknown>;
  const rawPath = value.path;
  if (typeof rawPath !== "string") {
    return false;
  }

  return allowedPaths.some((allowedPath) => {
    const absoluteAllowedPath = resolve(workspace, allowedPath);
    const absoluteCandidate = resolve(workspace, rawPath);
    return isAbsolutePathInside(absoluteAllowedPath, absoluteCandidate);
  });
}

function isAbsolutePathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
