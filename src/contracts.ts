export type AgentKind = "main" | "subagent";
export type AgentScope = "run" | "task" | "project" | "user";
export type AgentPersistence = "ephemeral" | "persistent";
export type AgentStatus =
  | "created"
  | "starting"
  | "running"
  | "waiting_input"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ToolName =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "grep"
  | "find"
  | "ls"
  | "create_agent"
  | "spawn_agent"
  | "delegate"
  | "list_agents"
  | "get_agent_result"
  | "cancel_agent";

export type OutputFormat = "text" | "json";

export interface OutputContract {
  format: OutputFormat;
  schemaName?: string;
  requiredSections: string[];
  requiredFields: string[];
  acceptanceCriteriaRequired: boolean;
  reportChangedFiles: boolean;
  reportTests: boolean;
  reportRisks: boolean;
}

export interface AgentIdentity {
  responsibilities: string[];
  nonResponsibilities: string[];
  systemPrompt: string;
}

export interface AgentExecutionPolicy {
  model: string;
  thinkingLevel: ThinkingLevel;
  tools: ToolName[];
  readOnly: boolean;
  writePaths: string[];
  canDelegate: boolean;
  maxDepth: number;
}

export interface AgentLimits {
  maxTurns: number;
  timeoutSeconds: number;
  maxCostUsd?: number;
  maxConcurrentChildren: number;
}

export interface AgentContextPolicy {
  includeParentSummary: boolean;
  includeTaskFiles: string[];
  loadProjectInstructions: boolean;
  memoryMode: "none" | "read" | "read-write";
}

export interface AgentLifecycle {
  persistence: AgentPersistence;
  scope: AgentScope;
  createdBy: "main-agent" | "user" | "system";
  createdAt: string;
  expiresAt?: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  version: number;
  description: string;
  kind: AgentKind;
  identity: AgentIdentity;
  execution: AgentExecutionPolicy;
  output: OutputContract;
  limits: AgentLimits;
  context: AgentContextPolicy;
  lifecycle: AgentLifecycle;
}

export interface CreateAgentRequest {
  name: string;
  description: string;
  responsibilities: string[];
  nonResponsibilities?: string[];
  systemPrompt?: string;
  requestedTools?: ToolName[];
  readOnly?: boolean;
  requestedWritePaths?: string[];
  requestedModel?: string;
  thinkingLevel?: ThinkingLevel;
  outputContract?: Partial<OutputContract>;
  canDelegate?: boolean;
  persistence?: AgentPersistence;
  scope?: AgentScope;
  reason: string;
  createdBy: "main-agent" | "user" | "system";
}

export interface AgentTask {
  id: string;
  runId?: string;
  taskId?: string;
  workspace: string;
  task: string;
  acceptanceCriteria: string[];
  parentSummary?: string;
  files?: string[];
  writePaths?: string[];
  depth: number;
}

export interface EffectiveProfileResult {
  profile: AgentProfile;
  warnings: string[];
}

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
}

export interface AgentResult {
  agentId: string;
  agentTaskId: string;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  output?: string;
  structuredOutput?: Record<string, unknown>;
  usage?: AgentUsage;
  changedFiles: string[];
  tests: TestResult[];
  risks: string[];
  error?: {
    code: string;
    message: string;
  };
}

/** Provider-reported usage for one Agent task. Credential values never appear here. */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface TestResult {
  command: string;
  passed: boolean;
  output?: string;
}

export interface AgentEvent {
  eventId: string;
  agentId: string;
  agentTaskId?: string;
  sessionId?: string;
  type: string;
  sequence: number;
  timestamp: string;
  payload: unknown;
}

export interface ToolAuthorizationContext {
  workspace: string;
  profile: AgentProfile;
}
