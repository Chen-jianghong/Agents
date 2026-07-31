import type { AgentProfile, AgentTask } from "./contracts.js";
import { AgentFactory } from "./factory.js";
import { PiAgentManager } from "./manager.js";
import { createOrchestrationTools, type OrchestrationToolContext } from "./orchestration-tools.js";
import { PiSessionFactory, type ManagedAgent, type PiSessionFactoryOptions } from "./pi-adapter.js";
import type { ProfileRegistry } from "./registry.js";
import type { ModelAliases } from "./model-runtime.js";
import type { ModelGateway } from "./model-gateway.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentWorkspaceProvider } from "./workspace.js";
import { ORCHESTRATION_TOOLS, READ_ONLY_TOOLS } from "./tool-policy.js";

export interface MainAgentOptions extends PiSessionFactoryOptions {
  workspace: string;
  runId?: string;
  taskWritePaths?: string[];
  initialTask?: AgentTask;
  modelRuntime?: ModelRuntime;
  modelAliases?: ModelAliases;
  modelGateway?: ModelGateway;
  workspaceProvider?: AgentWorkspaceProvider;
}

export function createMainAgentProfile(model = "coding-strong"): AgentProfile {
  const now = new Date().toISOString();
  return {
    id: "agent_main",
    name: "main-agent",
    version: 1,
    description: "Understands user requests and orchestrates specialist Agents.",
    kind: "main",
    identity: {
      responsibilities: [
        "Understand the user request",
        "Choose or create specialist Agents",
        "Delegate tasks and verify results",
        "Summarize the final outcome",
      ],
      nonResponsibilities: ["Do not modify business code directly"],
      systemPrompt: [
        "You are the main Agent for this project.",
        "Use create_agent or spawn_agent when a specialist is needed.",
        "Use delegate to run existing specialist Profiles.",
        "Do not directly modify business code; delegate code changes to an appropriately scoped Agent.",
      ].join("\n"),
    },
    execution: {
      model,
      thinkingLevel: "high",
      tools: [...READ_ONLY_TOOLS, ...ORCHESTRATION_TOOLS],
      readOnly: true,
      writePaths: [],
      canDelegate: true,
      maxDepth: 1,
    },
    output: {
      format: "text",
      requiredSections: ["summary", "verification", "risks"],
      requiredFields: [],
      acceptanceCriteriaRequired: true,
      reportChangedFiles: true,
      reportTests: true,
      reportRisks: true,
    },
    limits: {
      maxTurns: 50,
      timeoutSeconds: 3600,
      maxConcurrentChildren: 4,
    },
    context: {
      includeParentSummary: false,
      includeTaskFiles: [],
      loadProjectInstructions: true,
      memoryMode: "read-write",
    },
    lifecycle: {
      persistence: "ephemeral",
      scope: "run",
      createdBy: "system",
      createdAt: now,
    },
  };
}

export class MainAgentFactory {
  constructor(
    private readonly sessionFactory: PiSessionFactory,
    private readonly profileFactory: AgentFactory,
    private readonly registry: ProfileRegistry,
    private readonly manager: PiAgentManager,
  ) {}

  async create(options: MainAgentOptions): Promise<ManagedAgent> {
    const profile = createMainAgentProfile();
    const initialTask = options.initialTask ?? {
      id: "main-task",
      workspace: options.workspace,
      task: "Wait for the user's request.",
      acceptanceCriteria: [],
      depth: 0,
    };
    const toolContext: OrchestrationToolContext = {
      workspace: options.workspace,
      agentDir: options.agentDir,
      ...(options.runId ? { runId: options.runId } : {}),
      parentAgentId: profile.id,
      depth: 0,
      maxConcurrentChildren: profile.limits.maxConcurrentChildren,
      ...(options.taskWritePaths ? { taskWritePaths: options.taskWritePaths } : {}),
      ...(options.model ? { runOptions: { model: options.model } } : {}),
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      ...(options.modelAliases ? { modelAliases: options.modelAliases } : {}),
      ...(options.modelGateway ? { modelGateway: options.modelGateway } : {}),
      ...(options.workspaceProvider ? { workspaceProvider: options.workspaceProvider } : {}),
    };

    return this.sessionFactory.create(profile, initialTask, {
      cwd: options.cwd,
      agentDir: options.agentDir,
      ...(options.model ? { model: options.model } : {}),
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      ...(options.modelAliases ? { modelAliases: options.modelAliases } : {}),
      ...(options.modelGateway ? { modelGateway: options.modelGateway } : {}),
      customTools: createOrchestrationTools(
        this.profileFactory,
        this.registry,
        this.manager,
        toolContext,
      ),
    });
  }
}
