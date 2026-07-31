import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentUsage,
  AgentEvent,
  AgentProfile,
  AgentResult,
  AgentTask,
  AgentStatus,
  ToolName,
} from "./contracts.js";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { ModelAliases } from "./model-runtime.js";
import { resolveProfileModel } from "./model-runtime.js";
import type { ModelGateway } from "./model-gateway.js";
import { authorizeTool } from "./tool-policy.js";

const BUILT_IN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

export interface PiSessionFactoryOptions {
  cwd: string;
  agentDir: string;
  model?: NonNullable<CreateAgentSessionOptions["model"]>;
  modelRuntime?: ModelRuntime;
  modelAliases?: ModelAliases;
  modelGateway?: ModelGateway;
  customTools?: ToolDefinition[];
}

export interface ManagedAgent {
  readonly agentId: string;
  readonly sessionId: string;
  readonly profile: AgentProfile;
  readonly session: AgentSession;
  readonly status: AgentStatus;

  prompt(task: AgentTask): Promise<AgentResult>;
  cancel(): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}

export class PiSessionFactory {
  async create(
    profile: AgentProfile,
    task: AgentTask,
    options: PiSessionFactoryOptions,
  ): Promise<ManagedAgent> {
    if (options.modelGateway && options.modelRuntime && options.modelGateway.modelRuntime !== options.modelRuntime) {
      throw new Error("modelGateway and modelRuntime must use the same Pi ModelRuntime");
    }
    const modelRuntime = options.modelRuntime ?? options.modelGateway?.modelRuntime;
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      noExtensions: true,
      systemPromptOverride: (base) => [base, profile.identity.systemPrompt].filter(Boolean).join("\n\n"),
    });

    const sessionOptions: CreateAgentSessionOptions = {
      cwd: options.cwd,
      agentDir: options.agentDir,
      tools: profile.execution.tools.filter((tool) => BUILT_IN_TOOLS.has(tool) || options.customTools?.some((item) => item.name === tool)),
      resourceLoader,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
      }),
    };

    if (options.customTools) {
      sessionOptions.customTools = options.customTools;
    }

    if (options.model) {
      sessionOptions.model = options.model;
      sessionOptions.thinkingLevel = profile.execution.thinkingLevel;
    } else if (options.modelGateway) {
      const resolved = await options.modelGateway.resolve(
        profile.execution.model,
        profile.execution.thinkingLevel,
      );
      sessionOptions.model = resolved.model;
      sessionOptions.thinkingLevel = resolved.thinkingLevel;
    } else if (modelRuntime) {
      const resolved = resolveProfileModel(
        profile.execution.model,
        profile.execution.thinkingLevel,
        modelRuntime,
        options.modelAliases,
      );
      sessionOptions.model = resolved.model;
      sessionOptions.thinkingLevel = resolved.thinkingLevel;
    }

    if (modelRuntime) {
      sessionOptions.modelRuntime = modelRuntime;
    }

    const { session } = await createAgentSession(sessionOptions);
    const previousBeforeToolCall = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
      const authorization = authorizeTool(
        { workspace: options.cwd, profile },
        context.toolCall.name as ToolName,
        context.args,
      );
      if (!authorization.allowed) {
        return {
          block: true,
          ...(authorization.reason ? { reason: authorization.reason } : {}),
        };
      }
      return previousBeforeToolCall?.(context, signal);
    };
    return new PiManagedAgent(profile, session, task);
  }
}

class PiManagedAgent implements ManagedAgent {
  private currentStatus: AgentStatus = "created";
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly events: AgentEvent[] = [];
  private readonly output: string[] = [];
  private sequence = 0;
  private turnCount = 0;
  private turnLimitExceeded = false;
  private cancellationRequested = false;
  private costLimitExceeded = false;
  private usage: AgentUsage = emptyUsage();

  constructor(
    public readonly profile: AgentProfile,
    public readonly session: AgentSession,
    private readonly initialTask: AgentTask,
  ) {}

  get agentId(): string {
    return this.profile.id;
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get status(): AgentStatus {
    return this.currentStatus;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(task: AgentTask = this.initialTask): Promise<AgentResult> {
    this.currentStatus = "running";
    this.turnCount = 0;
    this.turnLimitExceeded = false;
    this.cancellationRequested = false;
    this.costLimitExceeded = false;
    this.usage = emptyUsage();
    const unsubscribe = this.session.subscribe((event) => this.handlePiEvent(event, task));

    try {
      await withTimeout(
        (async () => {
          await this.session.prompt(buildTaskMessage(task));
          await this.session.waitForIdle();
        })(),
        this.profile.limits.timeoutSeconds * 1000,
        async () => {
          await this.cancel();
        },
      );
      if (this.turnLimitExceeded) {
        throw new TurnLimitError(this.profile.limits.maxTurns);
      }
      if (this.costLimitExceeded) {
        return this.buildResult(task, "failed", {
          code: "agent_cost_limit_exceeded",
          message: `Agent exceeded the maximum cost of $${this.profile.limits.maxCostUsd!.toFixed(6)}`,
        });
      }
      if (this.cancellationRequested) {
        return this.buildResult(task, "cancelled", {
          code: "agent_cancelled",
          message: "Agent execution was cancelled",
        });
      }
      this.currentStatus = "completed";
      return this.buildResult(task, "completed");
    } catch (error) {
      this.currentStatus = "failed";
      if (error instanceof TimeoutError) {
        return this.buildResult(task, "timed_out", {
          code: "agent_timeout",
          message: error.message,
        });
      }
      if (error instanceof TurnLimitError) {
        return this.buildResult(task, "failed", {
          code: "agent_max_turns_exceeded",
          message: error.message,
        });
      }
      if (this.costLimitExceeded) {
        return this.buildResult(task, "failed", {
          code: "agent_cost_limit_exceeded",
          message: `Agent exceeded the maximum cost of $${this.profile.limits.maxCostUsd!.toFixed(6)}`,
        });
      }
      return this.buildResult(task, "failed", {
        code: "agent_execution_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      unsubscribe();
    }
  }

  async cancel(): Promise<void> {
    this.cancellationRequested = true;
    this.currentStatus = "cancelled";
    await this.session.abort();
  }

  private handlePiEvent(event: AgentSessionEvent, task: AgentTask): void {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      this.output.push(event.assistantMessageEvent.delta);
    }

    if (event.type === "turn_start") {
      if (this.turnCount >= this.profile.limits.maxTurns && !this.turnLimitExceeded) {
        this.turnLimitExceeded = true;
        void this.session.abort();
      } else {
        this.turnCount += 1;
      }
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      this.recordUsage(event.message.usage);
    }

    if (event.type === "compaction_end" && event.result?.usage) {
      this.recordUsage(event.result.usage);
    }

    if (
      event.type === "agent_end"
      && !this.turnLimitExceeded
      && !this.costLimitExceeded
      && !this.cancellationRequested
    ) {
      this.currentStatus = "completed";
    }

    const normalized: AgentEvent = {
      eventId: `${this.profile.id}:${task.id}:${this.sequence + 1}`,
      agentId: this.profile.id,
      agentTaskId: task.id,
      sessionId: this.session.sessionId,
      type: normalizePiEventType(event),
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      payload: event,
    };

    this.events.push(normalized);
    for (const listener of this.listeners) listener(normalized);
  }

  private buildResult(
    task: AgentTask,
    status: AgentResult["status"],
    error?: AgentResult["error"],
  ): AgentResult {
    return {
      agentId: this.profile.id,
      agentTaskId: task.id,
      status,
      output: this.output.join(""),
      usage: structuredClone(this.usage),
      changedFiles: [],
      tests: [],
      risks: [],
      ...(error ? { error } : {}),
    };
  }

  private recordUsage(usage: Usage): void {
    this.usage.inputTokens += nonNegativeFinite(usage.input);
    this.usage.outputTokens += nonNegativeFinite(usage.output);
    this.usage.cacheReadTokens += nonNegativeFinite(usage.cacheRead);
    this.usage.cacheWriteTokens += nonNegativeFinite(usage.cacheWrite);
    this.usage.totalTokens = this.usage.inputTokens
      + this.usage.outputTokens
      + this.usage.cacheReadTokens
      + this.usage.cacheWriteTokens;
    this.usage.costUsd += nonNegativeFinite(usage.cost.total);

    const maxCostUsd = this.profile.limits.maxCostUsd;
    if (maxCostUsd !== undefined && this.usage.costUsd > maxCostUsd && !this.costLimitExceeded) {
      this.costLimitExceeded = true;
      void this.session.abort();
    }
  }
}

function emptyUsage(): AgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function buildTaskMessage(task: AgentTask): string {
  const criteria = task.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const files = task.files?.length ? `\n\nFiles in scope:\n${task.files.join("\n")}` : "";
  const parent = task.parentSummary ? `\n\nParent context:\n${task.parentSummary}` : "";
  return `## Task\n${task.task}\n\n## Acceptance criteria\n${criteria || "No explicit criteria provided."}${files}${parent}`;
}

function normalizePiEventType(event: AgentSessionEvent): string {
  switch (event.type) {
    case "message_update":
      return "agent_assistant_delta";
    case "tool_execution_start":
      return "agent_tool_started";
    case "tool_execution_update":
      return "agent_tool_progress";
    case "tool_execution_end":
      return "agent_tool_finished";
    case "turn_start":
      return "agent_turn_started";
    case "turn_end":
      return "agent_turn_finished";
    case "agent_end":
      return "agent_completed";
    default:
      return `pi_${event.type}`;
  }
}

class TimeoutError extends Error {
  constructor() {
    super("Agent execution timed out");
    this.name = "TimeoutError";
  }
}

class TurnLimitError extends Error {
  constructor(maxTurns: number) {
    super(`Agent exceeded the maximum of ${maxTurns} turns`);
    this.name = "TurnLimitError";
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await awaitableRace(promise, timeoutMs, onTimeout, (handle) => {
      timer = handle;
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function awaitableRace<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
  captureTimer: (timer: ReturnType<typeof setTimeout>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      try {
        await onTimeout();
      } finally {
        reject(new TimeoutError());
      }
    }, timeoutMs);
    captureTimer(timer);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}
