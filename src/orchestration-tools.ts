import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentProfile,
  AgentTask,
  CreateAgentRequest,
  ToolName,
  ThinkingLevel,
} from "./contracts.js";
import { AgentFactory } from "./factory.js";
import { PiAgentManager, type AgentRunOptions } from "./manager.js";
import type { ProfileRegistry } from "./registry.js";
import type { ModelAliases } from "./model-runtime.js";
import type { ModelGateway } from "./model-gateway.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentWorkspaceProvider } from "./workspace.js";

const TOOL_NAMES = new Set<ToolName>([
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

export interface OrchestrationToolContext {
  workspace: string;
  agentDir: string;
  runId?: string;
  parentTaskId?: string;
  parentAgentId?: string;
  depth: number;
  taskWritePaths?: string[];
  maxConcurrentChildren?: number;
  runOptions?: Omit<AgentRunOptions, "cwd" | "agentDir">;
  modelRuntime?: ModelRuntime;
  modelAliases?: ModelAliases;
  modelGateway?: ModelGateway;
  workspaceProvider?: AgentWorkspaceProvider;
}

export function createOrchestrationTools(
  factory: AgentFactory,
  registry: ProfileRegistry,
  manager: PiAgentManager,
  context: OrchestrationToolContext,
): ToolDefinition[] {
  return [
    createAgentTool(factory, context),
    delegateTool(factory, registry, manager, context),
    spawnAgentTool(factory, registry, manager, context),
    listAgentsTool(registry),
    getAgentResultTool(manager),
    cancelAgentTool(manager),
  ];
}

function createAgentTool(factory: AgentFactory, context: OrchestrationToolContext): ToolDefinition {
  return defineTool({
    name: "create_agent",
    label: "Create Agent",
    description: "Create a temporary specialist Agent Profile for a later delegation.",
    promptSnippet: "Create a specialist Agent Profile without running it.",
    parameters: Type.Object({
      name: Type.String({ description: "Lowercase specialist name" }),
      description: Type.String(),
      responsibilities: Type.Array(Type.String()),
      nonResponsibilities: Type.Optional(Type.Array(Type.String())),
      requestedTools: Type.Optional(Type.Array(Type.String())),
      readOnly: Type.Optional(Type.Boolean()),
      requestedWritePaths: Type.Optional(Type.Array(Type.String())),
      requestedModel: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.String()),
      canDelegate: Type.Optional(Type.Boolean()),
      reason: Type.String(),
    }),
    async execute(_toolCallId, params) {
      const request: CreateAgentRequest = {
        name: params.name,
        description: params.description,
        responsibilities: params.responsibilities,
        ...(params.nonResponsibilities ? { nonResponsibilities: params.nonResponsibilities } : {}),
        ...(params.requestedTools ? { requestedTools: toToolNames(params.requestedTools) } : {}),
        ...(params.readOnly !== undefined ? { readOnly: params.readOnly } : {}),
        ...(params.requestedWritePaths ? { requestedWritePaths: params.requestedWritePaths } : {}),
        ...(params.requestedModel ? { requestedModel: params.requestedModel } : {}),
        ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel as ThinkingLevel } : {}),
        ...(params.canDelegate !== undefined ? { canDelegate: params.canDelegate } : {}),
        persistence: "ephemeral",
        scope: "task",
        reason: params.reason,
        createdBy: "main-agent",
      };
      const task = makeTask(context, `Profile creation: ${request.name}`, []);
      const result = factory.createProfile(request, task);
      return toolResult({
        agentId: result.profile.id,
        name: result.profile.name,
        status: "created",
        effectiveProfile: summarizeProfile(result.profile),
        warnings: result.warnings,
      });
    },
  });
}

function delegateTool(
  factory: AgentFactory,
  registry: ProfileRegistry,
  manager: PiAgentManager,
  context: OrchestrationToolContext,
): ToolDefinition {
  return defineTool({
    name: "delegate",
    label: "Delegate Task",
    description: "Run an existing Agent Profile in an isolated Pi Session.",
    promptSnippet: "Delegate a concrete task to an existing specialist Agent.",
    parameters: Type.Object({
      agentId: Type.String(),
      task: Type.String(),
      acceptanceCriteria: Type.Array(Type.String()),
      files: Type.Optional(Type.Array(Type.String())),
      writePaths: Type.Optional(Type.Array(Type.String())),
      runMode: Type.Optional(Type.Union([Type.Literal("foreground"), Type.Literal("background")])),
    }),
    async execute(_toolCallId, params) {
      const profile = registry.get(params.agentId);
      const task = makeTask(context, params.task, params.acceptanceCriteria, {
        ...(params.files ? { files: params.files } : {}),
        ...(params.writePaths ? { writePaths: params.writePaths } : {}),
      });
      const bound = factory.bindProfile(profile, task);
      const options = getRunOptions(context);
      if (params.runMode === "background") {
        const run = manager.runBackground(bound.profile, task, options);
        return toolResult({
          agentId: bound.profile.id,
          agentTaskId: run.agentTaskId,
          status: run.status,
          warnings: bound.warnings,
        });
      }

      const result = await manager.run(bound.profile, task, options);
      return toolResult({ result, warnings: bound.warnings });
    },
  });
}

function spawnAgentTool(
  factory: AgentFactory,
  registry: ProfileRegistry,
  manager: PiAgentManager,
  context: OrchestrationToolContext,
): ToolDefinition {
  return defineTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Create a temporary specialist and run its task immediately.",
    promptSnippet: "Create and run a one-off specialist Agent.",
    parameters: Type.Object({
      profile: Type.Object({
        name: Type.String(),
        description: Type.String(),
        responsibilities: Type.Array(Type.String()),
        nonResponsibilities: Type.Optional(Type.Array(Type.String())),
        requestedTools: Type.Optional(Type.Array(Type.String())),
        readOnly: Type.Optional(Type.Boolean()),
        requestedWritePaths: Type.Optional(Type.Array(Type.String())),
        requestedModel: Type.Optional(Type.String()),
        thinkingLevel: Type.Optional(Type.String()),
        canDelegate: Type.Optional(Type.Boolean()),
        reason: Type.String(),
      }),
      task: Type.String(),
      acceptanceCriteria: Type.Array(Type.String()),
      files: Type.Optional(Type.Array(Type.String())),
      writePaths: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params) {
      const request = params.profile;
      const profileRequest: CreateAgentRequest = {
        name: request.name,
        description: request.description,
        responsibilities: request.responsibilities,
        ...(request.nonResponsibilities ? { nonResponsibilities: request.nonResponsibilities } : {}),
        ...(request.requestedTools ? { requestedTools: toToolNames(request.requestedTools) } : {}),
        ...(request.readOnly !== undefined ? { readOnly: request.readOnly } : {}),
        ...(request.requestedWritePaths ? { requestedWritePaths: request.requestedWritePaths } : {}),
        ...(request.requestedModel ? { requestedModel: request.requestedModel } : {}),
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel as ThinkingLevel } : {}),
        ...(request.canDelegate !== undefined ? { canDelegate: request.canDelegate } : {}),
        persistence: "ephemeral",
        scope: "task",
        reason: request.reason,
        createdBy: "main-agent",
      };
      const task = makeTask(context, params.task, params.acceptanceCriteria, {
        ...(params.files ? { files: params.files } : {}),
        ...(params.writePaths ? { writePaths: params.writePaths } : {}),
      });
      const created = factory.createProfile(profileRequest, task);
      const result = await manager.run(created.profile, task, getRunOptions(context));
      return toolResult({
        agentId: created.profile.id,
        agentTaskId: result.agentTaskId,
        profileCreated: true,
        warnings: created.warnings,
        result,
      });
    },
  });
}

function listAgentsTool(registry: ProfileRegistry): ToolDefinition {
  return defineTool({
    name: "list_agents",
    label: "List Agents",
    description: "List Agent Profiles available to the current task.",
    promptSnippet: "List available specialist Agents.",
    parameters: Type.Object({}),
    async execute() {
      return toolResult(registry.list().map(summarizeProfile));
    },
  });
}

function getAgentResultTool(manager: PiAgentManager): ToolDefinition {
  return defineTool({
    name: "get_agent_result",
    label: "Get Agent Result",
    description: "Get the result of a foreground or background Agent task.",
    promptSnippet: "Read a delegated Agent result.",
    parameters: Type.Object({ agentTaskId: Type.String() }),
    async execute(_toolCallId, params) {
      const result = await manager.getResult(params.agentTaskId);
      return toolResult(result ?? { status: "not_found", agentTaskId: params.agentTaskId });
    },
  });
}

function cancelAgentTool(manager: PiAgentManager): ToolDefinition {
  return defineTool({
    name: "cancel_agent",
    label: "Cancel Agent",
    description: "Cancel a running delegated Agent.",
    promptSnippet: "Cancel a running specialist Agent.",
    parameters: Type.Object({ agentId: Type.String() }),
    async execute(_toolCallId, params) {
      await manager.cancel(params.agentId);
      return toolResult({ agentId: params.agentId, status: "cancelled" });
    },
  });
}

function makeTask(
  context: OrchestrationToolContext,
  taskText: string,
  acceptanceCriteria: string[],
  overrides: Partial<AgentTask> = {},
): AgentTask {
  return {
    id: `agent_task_${randomUUID()}`,
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.parentTaskId ? { taskId: context.parentTaskId } : {}),
    workspace: context.workspace,
    task: taskText,
    acceptanceCriteria,
    depth: context.depth + 1,
    ...(context.taskWritePaths ? { writePaths: context.taskWritePaths } : {}),
    ...overrides,
  };
}

function getRunOptions(context: OrchestrationToolContext): AgentRunOptions {
  return {
    cwd: context.workspace,
    agentDir: context.agentDir,
    ...(context.parentAgentId ? { parentAgentId: context.parentAgentId } : {}),
    ...(context.maxConcurrentChildren !== undefined ? { maxConcurrentChildren: context.maxConcurrentChildren } : {}),
    ...(context.runOptions?.model ? { model: context.runOptions.model } : {}),
    ...(context.modelRuntime ? { modelRuntime: context.modelRuntime } : {}),
    ...(context.modelAliases ? { modelAliases: context.modelAliases } : {}),
    ...(context.modelGateway ? { modelGateway: context.modelGateway } : {}),
    ...(context.workspaceProvider ? { workspaceProvider: context.workspaceProvider } : {}),
  };
}

function toToolNames(tools: string[]): ToolName[] {
  return tools.filter((tool): tool is ToolName => TOOL_NAMES.has(tool as ToolName));
}

function summarizeProfile(profile: AgentProfile): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name,
    version: profile.version,
    model: profile.execution.model,
    tools: profile.execution.tools,
    readOnly: profile.execution.readOnly,
    writePaths: profile.execution.writePaths,
    canDelegate: profile.execution.canDelegate,
  };
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}
