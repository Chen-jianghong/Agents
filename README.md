# Multi-Agent Dev Runtime

基于 Pi Agent Runtime 的多 Agent 开发运行时原型。

当前实现验证了以下核心关系：

```text
AgentProfile + Pi AgentSession + 权限策略 + 生命周期 = 我们的 Agent
```

主 Agent 和子 Agent 使用同一个 Pi Adapter。主 Agent 额外挂载：

- `create_agent`：创建临时 Agent Profile；
- `spawn_agent`：创建并立即执行一次性专家；
- `delegate`：执行已有 Agent Profile；
- `list_agents`、`get_agent_result`、`cancel_agent`：管理委派任务。

## 开发

要求 Node.js 22+，因为当前锁定的 Pi 版本为 `0.83.0`。

```bash
npm install --ignore-scripts
npm run typecheck
npm test
```

当前测试不需要 API Key。它们验证 Profile、权限裁剪、路径边界、分层 Registry、持久 Profile 审批、主 Agent 编排工具、Manager 事件桥、JSONL 事件持久化和脱敏、任务状态/结果恢复、超时/最大回合/并发限制、token/cost 用量统计和成本上限、真实 Pi Session 创建、Task DAG 校验与拓扑排序、Planner 输出解析校验、RunScheduler 依赖调度/失败传播/取消，以及 Pi faux Provider 驱动的 Main Agent -> `spawn_agent` -> Sub Agent 与 Planner -> RunScheduler -> 真实 Manager 端到端闭环；不会访问外部模型服务。

## 当前入口

```ts
import {
  createMultiAgentRuntime,
  type AgentTask,
} from "./src/index.js";

const runtime = createMultiAgentRuntime();
const mainAgent = await runtime.createMainAgent({
  cwd: process.cwd(),
  workspace: process.cwd(),
  agentDir: `${process.cwd()}/.pi`,
});

// 业务层后续通过 mainAgent.session.prompt(...) 接收用户请求。
// Main Agent 的编排工具已经由 factory 挂载到这个 Pi Session。
```

### Planner 与 Run 调度

自然语言需求经过 Planner 转成结构化 TaskDAG，再由 RunScheduler 按依赖和并发上限执行：

```ts
const scheduler = runtime.createRunScheduler({
  workspace: process.cwd(),
  agentDir: `${process.cwd()}/.pi`,
  maxParallel: 4,
});

// 1. 创建 Run（status: created）
const run = scheduler.createRun({
  goal: "为后台增加团队成员管理功能",
  workspace: process.cwd(),
});

// 2. 规划 + 调度（Planner 生成 DAG → 校验 → 并行执行）
await scheduler.startRun(run.runId);

// 3. 订阅 Run/Task 事件（run.created / task.running / run.succeeded ...）
scheduler.subscribe((event) => console.log(event.type, event.payload));

// 4. 等待终态
const result = await scheduler.waitForRun(run.runId);
```

Planner 输出必须符合 TaskDAG Schema（id 唯一、依赖无环、writePaths 不重叠、必须有验收标准），非法输出会让 Run 进入 `planning_failed`，不会启动任何 Worker。任务失败或取消时，依赖它的下游任务被阻塞（cancelled），无关任务继续执行。

模型接入分为两种方式：

- 直接给 `PiSessionFactoryOptions.model` 传入 Pi 的具体 Model 对象；
- 通过 `createMultiAgentRuntimeAsync()` 创建 Pi `ModelRuntime`，再通过 `modelAliases` 把我们的模型 Profile 名称映射到 Pi 的 `provider/model` 名称。

示例：

```ts
const runtime = await createMultiAgentRuntimeAsync({
  modelAliases: {
    "coding-strong": "anthropic/claude-sonnet-4-6",
    "coding-balanced": "deepseek/deepseek-chat",
  },
});
```

生产入口可以使用 `ModelGateway` 收拢模型路由和凭据边界。Gateway 只保存 `profile model -> provider/model` 映射，凭据由宿主解析器在 Session 创建前注入 Pi `ModelRuntime`：

```ts
const modelRuntime = await ModelRuntime.create({
  modelsPath: null,
  allowModelNetwork: false,
});
const gateway = new ModelGateway(modelRuntime, {
  aliases: {
    "coding-strong": "anthropic/claude-sonnet-4-6",
    "coding-balanced": "deepseek/deepseek-chat",
  },
  credentials: new EnvironmentCredentialResolver(),
});
const runtime = createMultiAgentRuntime({ modelGateway: gateway });
```

API Key 不进入 Agent Profile、路由配置、任务结果或普通日志。`AgentResult.usage` 只包含 token 数和美元成本数值；Profile 的 `limits.maxCostUsd` 超限时，Pi Session 会被中止并返回 `agent_cost_limit_exceeded`。当前尚未完成外部 Provider Gateway、模型配置中心和真实 API Key 管理服务；这些仍由宿主凭据解析器和 Pi `ModelRuntime` 承担。

## 持久 Profile

项目级和用户级 Profile 可以通过 `FileProfileStore` 保存为 JSON：

```ts
const store = new FileProfileStore({
  projectRoot: ".multi-agent-dev/agents",
  userRoot: "~/.multi-agent-dev/agents",
});

await store.saveApproved(profile, {
  approved: true,
  approvedBy: "user-id",
});
```

业务宿主推荐通过 `PersistentProfileService` 创建持久 Profile。普通 `AgentFactory` 和 Main Agent 工具只允许创建临时 Profile；持久化服务会在显式批准后创建、保存，保存失败时回滚 Registry 注册：

```ts
const runtime = createMultiAgentRuntime({ profileStore: store });
const persistentProfiles = runtime.persistentProfiles;
if (!persistentProfiles) throw new Error("profile store is required");

const created = await persistentProfiles.createApproved(
  {
    name: "api-researcher",
    description: "Investigate the API layer and report evidence",
    responsibilities: ["Trace API calls", "Report evidence"],
    requestedTools: ["read", "grep"],
    readOnly: true,
    persistence: "persistent",
    scope: "project",
    reason: "The project needs a reusable API specialist",
    createdBy: "user",
  },
  task,
  { approved: true, approvedBy: "user-id" },
);

await persistentProfiles.removeApproved(created.profile.id, "user-id");
```

持久化要求显式批准；每个版本会写入 `.versions/<profile>/v<version>.json`。加载时项目级 Profile 覆盖用户级同名 Profile，用户级又覆盖内置 Profile。临时 Profile 不会自动落盘。

## Control Plane

Runtime 提供 transport-neutral 的 `v1` 控制面协议，供 UI、WebSocket 或 Worker RPC 调用：

```ts
const response = await runtime.controlPlane.handle({
  version: "v1",
  requestId: "request-1",
  type: "get_result",
  agentTaskId: "task-id",
});
```

当前协议支持 Profile/Task/Result 查询、Agent 取消和失败任务重试；`retry_agent` 只允许重试失败、取消或超时的任务，已完成任务不会被覆盖。协议不会暴露 Pi Session、ModelRuntime 或凭据对象。

Task Store 会保存提交时绑定的 Profile 快照，以及不含 ModelRuntime、ModelGateway、凭据或 Workspace Provider 实例的安全执行快照。Manager 重启后可以通过 `retry_agent` 恢复失败、取消、超时或孤儿运行任务，但跨进程恢复必须由宿主注入 `taskRecovery.resolveExecution`；宿主需要重新提供 `cwd`、`agentDir`、模型运行时、模型路由、凭据边界和工作区 Provider。没有恢复解析器时，Runtime 会返回结构化的 `agent_retry_execution_unavailable`，不会猜测使用当前同名 Profile 或绕过原有工作区隔离。

如果需要从 UI、Worker 或其他宿主提交后台 Agent 任务，必须由宿主显式配置执行工作区和 Agent 目录。提交时只传 Profile ID 与序列化任务，Runtime 会先按任务边界绑定 Profile，再调用 `PiAgentManager.runBackground`：

```ts
const runtime = createMultiAgentRuntime({
  manager: { maxConcurrentTasks: 4 },
  controlPlaneExecution: {
    cwd: process.cwd(),
    agentDir: `${process.cwd()}/.pi`,
  },
});

const submitted = await runtime.controlPlane.handle({
  version: "v1",
  requestId: "submit-1",
  type: "run_agent",
  profileId: "researcher",
  task: {
    id: "task-1",
    workspace: process.cwd(),
    task: "Inspect the API layer",
    acceptanceCriteria: ["Return evidence"],
    depth: 0,
  },
});
```

可写 Agent 可以额外绑定 Git worktree。只读 Profile 会继续使用原工作区；worktree 会在任务完成后自动释放：

```ts
const workspaceProvider = new GitWorktreeProvider({
  worktreeRoot: `${process.cwd()}/.agent-worktrees`,
});
const runtime = createMultiAgentRuntime({
  controlPlaneExecution: {
    cwd: process.cwd(),
    agentDir: `${process.cwd()}/.pi`,
    workspaceProvider,
  },
});
```

未配置 `controlPlaneExecution`、任务工作区与宿主工作区不一致，或 Profile 不存在时，提交会被拒绝。执行所需的 ModelRuntime、ModelGateway 和并发上下文由宿主配置，不从外部 JSON 请求接收。配置 `manager.maxConcurrentTasks` 后，超出上限的提交返回 `queued`，任务按 FIFO 顺序启动；`get_task` 可以读取 `queued`、`starting`、`running` 和终态快照。

Runtime 还提供 HTTP JSON/SSE transport，默认只绑定 `127.0.0.1`，可通过 `authorize` 注入宿主鉴权：

```ts
const server = runtime.createControlPlaneHttpServer({
  port: 8787,
  authorize: (request) => request.headers["x-control-token"] === process.env.CONTROL_TOKEN,
});
await server.start();
```

同一套 `v1` 协议也可以通过独立的 WebSocket transport 提供双向请求和实时事件推送。默认仍只绑定 `127.0.0.1`，连接握手会先执行宿主鉴权：

```ts
const server = runtime.createControlPlaneWebSocketServer({
  port: 8788,
  authorize: (request) => request.headers["x-control-token"] === process.env.CONTROL_TOKEN,
});
await server.start();
```

客户端连接成功后会收到 `ready` 消息；请求使用与 HTTP 相同的 `ControlPlaneRequest` JSON，响应使用 `ControlPlaneResponse` JSON，实时 Agent 事件使用 `type: "event"` 推送。WebSocket transport 会限制单消息大小和发送缓冲区，并对推送事件做敏感字段脱敏。

Worker 场景可以直接复用同一控制面作为 JSONL RPC。父进程与 Worker 之间一行一个 JSON 帧，首帧为 `ready`，配置了 `authorize` 时先交换 `authenticate`/`authenticated` 帧：

```ts
const workerRpc = runtime.createControlPlaneWorkerRpcServer(process.stdin, process.stdout, {
  authorize: (token) => token === process.env.WORKER_TOKEN,
});
workerRpc.start();
```

父进程可使用 `ControlPlaneWorkerRpcClient` 发送同一组 `ControlPlaneRequest`，并订阅 `type: "event"` 帧。JSONL transport 会限制帧大小、串行化输出并在背压或断开时结束连接。

宿主侧可以用 `createControlPlaneWorkerProcess()` 管理独立 Worker 的启动、RPC 握手、停止和异常退出：

```ts
const worker = runtime.createControlPlaneWorkerProcess({
  command: process.execPath,
  args: ["worker-entry.mjs"],
  token: process.env.WORKER_TOKEN,
});
await worker.start();
const response = await worker.request({
  version: "v1",
  requestId: "profiles-1",
  type: "list_profiles",
});
await worker.stop();
```

Supervisor 会强制使用非 shell 子进程，支持启动/停止超时，并在 Worker 异常退出时拒绝未完成的请求。

## 目录

```text
src/
├── contracts.ts             # AgentProfile、Task、Result、Event
├── plan-contracts.ts        # Run/Task 状态机、PlanTask/TaskDAG、校验/规划结果契约
├── dag.ts                   # Task DAG 校验、拓扑排序、就绪/阻塞计算
├── planner.ts               # Planner Profile、prompt 构建、DAG JSON 解析与校验
├── run-scheduler.ts         # Run 生命周期、依赖调度、并发、失败传播、取消
├── profile-validator.ts     # Profile/请求校验
├── tool-policy.ts           # 工具和路径权限
├── registry.ts              # Profile Registry
├── profile-store.ts         # 项目/用户级持久 Profile 和版本快照
├── profile-service.ts       # 宿主批准后的持久 Profile 组合服务
├── model-gateway.ts         # 模型路由和宿主凭据边界
├── factory.ts               # Profile 创建和能力裁剪
├── builtins.ts              # researcher/coder/tester/reviewer
├── pi-adapter.ts            # Pi 0.83 AgentSession Adapter
├── manager.ts               # Agent Session 生命周期和结果
├── event-store.ts           # JSONL Agent 事件存储和敏感字段脱敏
├── task-store.ts            # Agent 任务状态/结果快照和恢复
├── workspace.ts              # Passthrough/Git Worktree 工作区 Provider
├── control-plane.ts         # v1 控制面 DTO、命令分发和事件订阅
├── control-plane-http.ts    # HTTP JSON/SSE transport 和鉴权钩子
├── control-plane-ws.ts      # WebSocket transport、事件推送和背压限制
├── control-plane-worker-rpc.ts # Worker JSONL RPC、鉴权和帧边界
├── worker-process.ts         # Worker 子进程启动、握手、停止和异常退出管理
├── orchestration-tools.ts   # 主 Agent 编排工具
├── main-agent.ts            # Main Agent Profile/Factory
└── runtime.ts               # 一键组装 Runtime
```

下一阶段接入顺序：

1. 外部 Provider Gateway、模型配置中心和真实 API Key 管理服务；
2. Control Plane 调度（Run/DAG 命令）和客户端展示；
3. Worker 进程的分布式队列调度和容器隔离；
4. 配额、成本汇总和更细的重试策略。
