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
import type { ControlPlaneExecutionDefaults } from "./control-plane.js";

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
  readonly controlPlane: AgentControlPlane;
  createControlPlaneHttpServer(options?: ControlPlaneHttpServerOptions): ControlPlaneHttpServer;
  createControlPlaneWebSocketServer(options?: ControlPlaneWebSocketServerOptions): ControlPlaneWebSocketServer;
  createControlPlaneWorkerRpcServer(
    input: Readable,
    output: Writable,
    options?: ControlPlaneWorkerRpcServerOptions,
  ): ControlPlaneWorkerRpcServer;
  createControlPlaneWorkerProcess(options: ControlPlaneWorkerProcessOptions): ControlPlaneWorkerProcess;
  createMainAgent(options: MainAgentOptions): Promise<ManagedAgent>;
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
  const controlPlane = new AgentControlPlane(registry, manager, {
    factory,
    ...(controlPlaneExecution ? { execution: controlPlaneExecution } : {}),
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
  const mainAgentFactory = new MainAgentFactory(sessionFactory, factory, registry, manager);
  const persistentProfiles = options.profileStore
    ? new PersistentProfileService(factory, registry, options.profileStore)
    : undefined;
  const createMainAgent = (mainOptions: MainAgentOptions) => mainAgentFactory.create({
    ...mainOptions,
    ...(modelRuntime ? { modelRuntime } : {}),
    ...(options.modelGateway ? { modelGateway: options.modelGateway } : {}),
    ...(Object.keys(modelAliases).length > 0 ? { modelAliases } : {}),
  });

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
    controlPlane,
    createControlPlaneHttpServer,
    createControlPlaneWebSocketServer,
    createControlPlaneWorkerRpcServer,
    createControlPlaneWorkerProcess,
    ...(persistentProfiles ? { persistentProfiles } : {}),
    createMainAgent,
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
  return runtime;
}
