import type { Model } from "@earendil-works/pi-ai/compat";
import type { Readable, Writable } from "node:stream";
import { AgentFactory, DEFAULT_FACTORY_POLICY, type FactoryPolicy } from "./factory.js";
import { createBuiltInProfiles } from "./builtins.js";
import { MainAgentFactory } from "./main-agent.js";
import type { MainAgentOptions } from "./main-agent.js";
import { PiAgentManager, type AgentManagerOptions } from "./manager.js";
import { PiSessionFactory, type ManagedAgent } from "./pi-adapter.js";
import { LayeredProfileRegistry } from "./registry.js";
import { ModelRuntime, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import type { ModelAliases } from "./model-runtime.js";
import { FileProfileStore } from "./profile-store.js";
import { PersistentProfileService } from "./profile-service.js";
import { ModelGateway } from "./model-gateway.js";
import type { AgentEventStore } from "./event-store.js";
import type { AgentTaskStore } from "./task-store.js";
import { AgentControlPlane } from "./control-plane.js";
import {
  ControlPlaneHttpServer,
  type ControlPlaneHttpServerOptions,
} from "./control-plane-http.js";
import {
  ControlPlaneWebSocketServer,
  type ControlPlaneWebSocketServerOptions,
} from "./control-plane-ws.js";
import {
  ControlPlaneWorkerRpcServer,
  type ControlPlaneWorkerRpcServerOptions,
} from "./control-plane-worker-rpc.js";
import {
  ControlPlaneWorkerProcess,
  type ControlPlaneWorkerProcessOptions,
} from "./worker-process.js";
import {
  MultiAgentRestApiServer,
  type MultiAgentRestApiServerOptions,
} from "./rest-api.js";
import type { RunStore } from "./run-store.js";
import type { ControlPlaneExecutionDefaults } from "./control-plane.js";
import { PlannerService } from "./planner.js";
import { RunScheduler } from "./run-scheduler.js";
import { FileModelConfigStore, type ModelProfileConfig } from "./model-config.js";
import { ModelConfigService, type SecretStore } from "./model-config-service.js";
import type { RunIntegrator } from "./run-integrator.js";
import type { RunReviewer } from "./run-reviewer.js";
import type { AuthService } from "./auth.js";

export interface MultiAgentRuntimeOptions {
  policy?: FactoryPolicy;
  now?: () => string;
  modelRuntime?: ModelRuntime;
  modelAliases?: ModelAliases;
  modelGateway?: ModelGateway;
  modelRuntimeOptions?: CreateModelRuntimeOptions;
  manager?: AgentManagerOptions;
  controlPlaneExecution?: Omit<ControlPlaneExecutionDefaults, "modelRuntime" | "modelAliases" | "modelGateway">;
  profileStore?: FileProfileStore;
  eventStore?: AgentEventStore;
  taskStore?: AgentTaskStore;
  /** Persist Run snapshots so terminal Runs survive a host restart. */
  runStore?: RunStore;
  /** JSON store for the model configuration center. */
  modelConfigStore?: FileModelConfigStore;
  /** Host secret vault referenced by provider apiKeySecretRef. */
  secrets?: SecretStore;
  /** Default model profiles seeded when the store has none. */
  defaultModelProfiles?: ModelProfileConfig[];
  /** Optional integrator for Control Plane / REST integrate_run commands. */
  integrator?: RunIntegrator;
  /** Optional reviewer for Control Plane / REST review_run commands. */
  reviewer?: RunReviewer;
  /** Optional auth service for REST /api/auth/* and authorization. */
  auth?: AuthService;
  /**
   * Build a shared RunScheduler from controlPlaneExecution and mount it on
   * the Control Plane (requires controlPlaneExecution). When false or
   * omitted, Run commands return run_submission_unavailable.
   */
  controlPlaneScheduler?: RuntimeControlPlaneSchedulerOptions | boolean;
}

/** Options for the Control Plane's shared RunScheduler. */
export interface RuntimeControlPlaneSchedulerOptions {
  /** Default parallelism bound for Runs (per-create_run override allowed). */
  maxParallel?: number;
  /** Model profile name for the Planner session. */
  plannerModelProfile?: string;
  eventStore?: AgentEventStore;
}

export interface RuntimeRunSchedulerOptions {
  /** Project workspace the Run executes in. */
  workspace: string;
  /** Pi agent directory; defaults to <workspace>/.pi. */
  agentDir?: string;
  /** Model profile name for the Planner session. */
  plannerModelProfile?: string;
  /** Default parallelism bound for Runs. */
  maxParallel?: number;
  modelRuntime?: ModelRuntime;
  modelAliases?: ModelAliases;
  modelGateway?: ModelGateway;
  eventStore?: AgentEventStore;
  runStore?: RunStore;
}

export interface MultiAgentRuntime {
  readonly registry: LayeredProfileRegistry;
  readonly factory: AgentFactory;
  readonly sessionFactory: PiSessionFactory;
  readonly manager: PiAgentManager;
  readonly mainAgentFactory: MainAgentFactory;
  readonly defaultModel: string;
  readonly modelRuntime?: ModelRuntime;
  readonly modelAliases: ModelAliases;
  readonly modelGateway?: ModelGateway;
  readonly profileStore?: FileProfileStore;
  readonly persistentProfiles?: PersistentProfileService;
  readonly eventStore?: AgentEventStore;
  readonly taskStore?: AgentTaskStore;
  readonly runStore?: RunStore;
  readonly modelConfig?: ModelConfigService;
  readonly controlPlane: AgentControlPlane;
  /** Shared RunScheduler mounted on the Control Plane (when configured). */
  readonly controlPlaneScheduler?: RunScheduler;
  createControlPlaneHttpServer(options?: ControlPlaneHttpServerOptions): ControlPlaneHttpServer;
  createControlPlaneWebSocketServer(options?: ControlPlaneWebSocketServerOptions): ControlPlaneWebSocketServer;
  createControlPlaneWorkerRpcServer(
    input: Readable,
    output: Writable,
    options?: ControlPlaneWorkerRpcServerOptions,
  ): ControlPlaneWorkerRpcServer;
  createControlPlaneWorkerProcess(options: ControlPlaneWorkerProcessOptions): ControlPlaneWorkerProcess;
  /** REST API over the Control Plane (project plan Phase 5). */
  createRestApiServer(options?: MultiAgentRestApiServerOptions): MultiAgentRestApiServer;
  createMainAgent(options: MainAgentOptions): Promise<ManagedAgent>;
  /** Build a RunScheduler wired to this runtime's manager/factory/registry. */
  createRunScheduler(options: RuntimeRunSchedulerOptions): RunScheduler;
  resolveModelName(model?: Model<any>): string;
}

export function createMultiAgentRuntime(options: MultiAgentRuntimeOptions = {}): MultiAgentRuntime {
  const policy = options.policy ?? DEFAULT_FACTORY_POLICY;
  const now = options.now ?? (() => new Date().toISOString());
  if (options.modelGateway && options.modelRuntime && options.modelGateway.modelRuntime !== options.modelRuntime) {
    throw new Error("modelGateway and modelRuntime must use the same Pi ModelRuntime");
  }
  const modelRuntime = options.modelRuntime ?? options.modelGateway?.modelRuntime;
  const modelAliases = options.modelAliases ?? options.modelGateway?.aliases ?? {};
  const registry = new LayeredProfileRegistry();

  for (const profile of createBuiltInProfiles(now())) {
    registry.registerBuiltIn(profile);
  }

  // Model configuration center: persists Providers / Model Profiles / Role
  // Bindings and drives aliases for new Sessions ("new tasks use new config").
  const modelConfig = options.modelConfigStore
    ? new ModelConfigService({
      store: options.modelConfigStore,
      ...(options.secrets ? { secrets: options.secrets } : {}),
      ...(options.defaultModelProfiles ? { defaultModelProfiles: options.defaultModelProfiles } : {}),
      now,
    })
    : undefined;
  modelConfig?.seedModelProfiles();

  const factory = new AgentFactory(registry, policy, now);
  const sessionFactory = new PiSessionFactory();
  const controlPlaneExecution = options.controlPlaneExecution
    ? {
      ...options.controlPlaneExecution,
      ...(modelRuntime ? { modelRuntime } : {}),
      ...(Object.keys(modelAliases).length > 0 ? { modelAliases } : {}),
      ...(options.modelGateway ? { modelGateway: options.modelGateway } : {}),
    }
    : undefined;
  const managerOptions: AgentManagerOptions = { ...(options.manager ?? {}) };
  if (controlPlaneExecution && !managerOptions.taskRecovery) {
    managerOptions.taskRecovery = {
      resolveExecution: () => ({ ...controlPlaneExecution }),
    };
  }
  const manager = new PiAgentManager(sessionFactory, options.eventStore, options.taskStore, managerOptions);
  const buildRunScheduler = (schedulerOptions: RuntimeRunSchedulerOptions): RunScheduler => {
    const agentDir = schedulerOptions.agentDir ?? `${schedulerOptions.workspace}/.pi`;
    const schedulerModelRuntime = schedulerOptions.modelRuntime ?? modelRuntime;
    const schedulerModelGateway = schedulerOptions.modelGateway
      ?? options.modelGateway
      ?? (modelConfig && modelRuntime ? gatewayFromConfig(modelConfig, modelRuntime) : undefined);
    const schedulerModelAliases = schedulerOptions.modelAliases
      ?? (schedulerModelGateway ? schedulerModelGateway.aliases : modelAliases);
    const planner = new PlannerService(sessionFactory, {
      cwd: schedulerOptions.workspace,
      agentDir,
      ...(schedulerOptions.plannerModelProfile ? { modelProfile: schedulerOptions.plannerModelProfile } : {}),
      ...(schedulerModelRuntime ? { modelRuntime: schedulerModelRuntime } : {}),
      ...(Object.keys(schedulerModelAliases).length > 0 ? { modelAliases: schedulerModelAliases } : {}),
      ...(schedulerModelGateway ? { modelGateway: schedulerModelGateway } : {}),
    });
    return new RunScheduler({
      planner,
      manager,
      factory,
      registry,
      ...(schedulerModelRuntime ? { modelRuntime: schedulerModelRuntime } : {}),
      ...(Object.keys(schedulerModelAliases).length > 0 ? { modelAliases: schedulerModelAliases } : {}),
      ...(schedulerModelGateway ? { modelGateway: schedulerModelGateway } : {}),
      ...(schedulerOptions.maxParallel !== undefined ? { maxParallel: schedulerOptions.maxParallel } : {}),
      ...(schedulerOptions.eventStore ?? options.eventStore ? { eventStore: schedulerOptions.eventStore ?? options.eventStore } : {}),
      ...(schedulerOptions.runStore ?? options.runStore ? { runStore: schedulerOptions.runStore ?? options.runStore } : {}),
    });
  };

  // Shared RunScheduler mounted on the Control Plane. It inherits the
  // host execution defaults (workspace, agentDir, model routing) so Run
  // commands never receive a workspace or model runtime from the wire.
  const controlPlaneScheduler = options.controlPlaneScheduler && controlPlaneExecution
    ? buildRunScheduler({
      workspace: controlPlaneExecution.cwd,
      agentDir: controlPlaneExecution.agentDir,
      ...(typeof options.controlPlaneScheduler === "object"
        ? {
          ...(options.controlPlaneScheduler.maxParallel !== undefined
            ? { maxParallel: options.controlPlaneScheduler.maxParallel }
            : {}),
          ...(options.controlPlaneScheduler.plannerModelProfile
            ? { plannerModelProfile: options.controlPlaneScheduler.plannerModelProfile }
            : {}),
          ...(options.controlPlaneScheduler.eventStore
            ? { eventStore: options.controlPlaneScheduler.eventStore }
            : {}),
        }
        : {}),
    })
    : undefined;
  const controlPlane = new AgentControlPlane(registry, manager, {
    factory,
    ...(controlPlaneExecution ? { execution: controlPlaneExecution } : {}),
    ...(controlPlaneScheduler ? { runScheduler: controlPlaneScheduler } : {}),
    ...(options.eventStore ? { eventStore: options.eventStore } : {}),
    ...(options.integrator ? { integrator: options.integrator } : {}),
    ...(options.reviewer ? { reviewer: options.reviewer } : {}),
  });
  const createControlPlaneHttpServer = (serverOptions: ControlPlaneHttpServerOptions = {}) =>
    new ControlPlaneHttpServer(controlPlane, serverOptions);
  const createControlPlaneWebSocketServer = (serverOptions: ControlPlaneWebSocketServerOptions = {}) =>
    new ControlPlaneWebSocketServer(controlPlane, serverOptions);
  const createControlPlaneWorkerRpcServer = (
    input: Readable,
    output: Writable,
    rpcOptions: ControlPlaneWorkerRpcServerOptions = {},
  ) => new ControlPlaneWorkerRpcServer(controlPlane, input, output, rpcOptions);
  const createControlPlaneWorkerProcess = (processOptions: ControlPlaneWorkerProcessOptions) =>
    new ControlPlaneWorkerProcess(processOptions);
  const createRestApiServer = (apiOptions: MultiAgentRestApiServerOptions = {}) =>
    new MultiAgentRestApiServer(controlPlane, {
      ...apiOptions,
      ...(apiOptions.defaultWorkspace === undefined && controlPlaneExecution
        ? { defaultWorkspace: controlPlaneExecution.cwd }
        : {}),
      ...(apiOptions.modelConfig === undefined && modelConfig
        ? { modelConfig }
        : {}),
      ...(apiOptions.auth === undefined && options.auth ? { auth: options.auth } : {}),
    });
  const mainAgentFactory = new MainAgentFactory(sessionFactory, factory, registry, manager);
  const persistentProfiles = options.profileStore
    ? new PersistentProfileService(factory, registry, options.profileStore)
    : undefined;
  const createMainAgent = (mainOptions: MainAgentOptions) => {
    const gateway = mainOptions.modelGateway
      ?? options.modelGateway
      ?? (modelConfig && modelRuntime ? gatewayFromConfig(modelConfig, modelRuntime) : undefined);
    const aliases = mainOptions.modelAliases
      ?? (gateway ? gateway.aliases : modelAliases);
    return mainAgentFactory.create({
      ...mainOptions,
      ...(modelRuntime ? { modelRuntime } : {}),
      ...(gateway ? { modelGateway: gateway } : {}),
      ...(Object.keys(aliases).length > 0 ? { modelAliases: aliases } : {}),
    });
  };

  const createRunScheduler = (schedulerOptions: RuntimeRunSchedulerOptions): RunScheduler =>
    buildRunScheduler(schedulerOptions);

  return {
    registry,
    factory,
    sessionFactory,
    manager,
    mainAgentFactory,
    defaultModel: policy.defaultModel,
    ...(modelRuntime ? { modelRuntime } : {}),
    modelAliases,
    ...(options.modelGateway ? { modelGateway: options.modelGateway } : {}),
    ...(options.profileStore ? { profileStore: options.profileStore } : {}),
    ...(options.eventStore ? { eventStore: options.eventStore } : {}),
    ...(options.taskStore ? { taskStore: options.taskStore } : {}),
    ...(options.runStore ? { runStore: options.runStore } : {}),
    ...(modelConfig ? { modelConfig } : {}),
    controlPlane,
    ...(controlPlaneScheduler ? { controlPlaneScheduler } : {}),
    createControlPlaneHttpServer,
    createControlPlaneWebSocketServer,
    createControlPlaneWorkerRpcServer,
    createControlPlaneWorkerProcess,
    createRestApiServer,
    ...(persistentProfiles ? { persistentProfiles } : {}),
    createMainAgent,
    createRunScheduler,
    resolveModelName: (model) => model?.id ?? policy.defaultModel,
  };
}

export async function createMultiAgentRuntimeAsync(
  options: MultiAgentRuntimeOptions = {},
): Promise<MultiAgentRuntime> {
  const modelRuntime = options.modelRuntime
    ?? options.modelGateway?.modelRuntime
    ?? await ModelRuntime.create(options.modelRuntimeOptions);
  const runtime = createMultiAgentRuntime({ ...options, modelRuntime });
  if (options.profileStore) {
    await options.profileStore.loadInto(runtime.registry);
  }
  if (options.modelConfigStore && runtime.modelConfig) {
    // Load persisted Providers / Model Profiles / Role Bindings and re-seed
    // any missing defaults. Config changes take effect for new sessions.
    await runtime.modelConfig.load();
  }
  if (options.runStore && runtime.controlPlaneScheduler) {
    // Restore persisted Runs: terminal ones as-is, interrupted ones as
    // host_restarted failures (task recovery via retry_agent).
    await runtime.controlPlaneScheduler.loadRuns();
  }
  return runtime;
}

/** Build a ModelGateway from the config center's current aliases + secrets. */
function gatewayFromConfig(
  config: ModelConfigService,
  modelRuntime: ModelRuntime,
): ModelGateway | undefined {
  const aliases = config.buildAliases();
  if (Object.keys(aliases).length === 0) return undefined;
  return new ModelGateway(modelRuntime, {
    aliases,
    credentials: config.createCredentialResolver(),
  });
}
