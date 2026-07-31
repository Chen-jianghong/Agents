# 主 Agent 动态创建子 Agent 方案

> 版本：v0.1
>
> 日期：2026-07-31
>
> 适用项目：Multi-Agent Dev
>
> 底座：Pi Agent Runtime / `@earendil-works/pi-coding-agent`

---

## 1. 目标

本方案为现有《多 Agent 并行开发平台方案企划书》补充“主 Agent 动态创建和调用子 Agent”的能力。

目标是让主 Agent 可以根据当前任务创建一个新的专家 Agent，并在创建后立即调用；也可以把成熟的职责保存为项目级或全局级 Profile，供后续任务通过名称重复调用。

期望使用体验：

```text
用户：分析当前项目的 React 性能问题，必要时创建一个专家 Agent。

主 Agent：发现需要 React 性能专家。
主 Agent：调用 create_agent 创建 react-performance-reviewer。
主 Agent：调用 delegate 将分析任务交给该 Agent。
主 Agent：汇总分析结果并向用户报告。
```

代码调用形式：

```ts
await agentManager.run("researcher", {
  task: "分析当前项目的数据库访问层",
  acceptanceCriteria: [
    "列出主要模块和调用链",
    "指出潜在性能问题",
    "给出有文件位置依据的建议",
  ],
});
```

本方案不修改 Pi 核心源码，优先通过 Pi SDK、Pi Agent Core、Pi Extension 和独立 Worker 实现。

---

## 2. 核心判断

### 2.1 子 Agent 不是一个 Prompt

一个可调用的子 Agent 必须是一个完整的运行配置：

```text
AgentProfile
├── 身份与职责        system prompt
├── 工具集合          tools
├── 权限边界          permissions
├── 工作区范围        workspace / writePaths
├── 模型配置          model profile
├── 输出契约          output contract
├── 委派策略          delegation policy
├── 上下文策略        context / memory policy
└── 资源限制          turns / time / cost / concurrency
```

Prompt 负责告诉模型“应该做什么”；Runtime 负责保证模型“实际上只能做什么”。

### 2.2 主 Agent 可以创建职责，但不能创建任意权限

主 Agent 可以提出：

- Agent 名称和描述；
- 职责说明；
- 目标和非目标；
- 模型和推理级别；
- 输出格式；
- 是否只读；
- 希望使用的工具；
- 是否允许继续委派。

宿主 Runtime 必须最终决定：

- 工具是否真正可用；
- 是否允许写文件；
- 允许写入哪些路径；
- 是否允许执行 Shell；
- 是否允许访问网络或 MCP；
- 是否允许创建子 Agent；
- 最大递归深度、并发数、执行轮数和成本。

主 Agent 提交的是“能力申请”，不是安全策略。

### 2.3 动态 Agent 分为临时和持久两类

```text
临时 Agent
  生命周期绑定当前 Run 或 Task
  默认不写入用户配置
  适合一次性专家、错误分析、临时技术调研

持久 Agent
  保存到项目或用户级 Agent Registry
  后续通过 name/id 调用
  适合 researcher、coder、reviewer 等长期角色
```

默认策略是：主 Agent 创建临时 Agent；只有用户明确要求“保存这个角色”“以后都使用”或宿主策略允许时，才能持久化。

---

## 3. Agent 的定义与系统边界

### 3.1 我们的 Agent 基于 Pi 如何组成

本项目不重新实现 LLM 调用和 Agent Loop，也不为 `researcher`、`coder`、`reviewer` 分别编写独立的 Agent 类。Pi 提供运行内核；本项目在上层把一个可运行的 Agent 组合为：

```text
我们的 Agent
  = AgentProfile
  + Pi AgentSession
  + 有效工具集合
  + 权限与工作区策略
  + 上下文策略
  + 生命周期管理
  + 结果输出契约
```

Pi 各层的职责保持清晰：

```text
pi-ai
  模型、Provider、认证、流式响应、Token/Cost

pi-agent-core
  Agent Loop、工具调用、状态、事件、Steering/Follow-up

pi-coding-agent
  Coding Agent Session、内置编码工具、Session 管理、SDK/RPC

本项目 Runtime
  AgentProfile、权限裁剪、父子关系、任务状态、审计、调度和结果协议
```

因此，`AgentProfile` 是“这个 Agent 是谁以及允许做什么”，`AgentSession` 是“这个 Agent 当前如何运行”，而 `ManagedAgent` 是我们对二者以及生命周期的统一封装：

```ts
interface ManagedAgent {
  agentId: string;
  sessionId?: string;
  kind: "main" | "subagent";
  profile: AgentProfile;
  session: AgentSession;
  status: AgentStatus;

  prompt(task: AgentTask): Promise<AgentResult>;
  cancel(): Promise<void>;
}
```

`researcher`、`coder`、`reviewer` 只是不同的 `AgentProfile`，由同一个 `AgentFactory` 创建；它们不应该变成三套重复的 Agent Loop。

### 3.2 主 Agent 也是同一种 Agent

主 Agent 和子 Agent 使用同一套 `AgentProfile + Pi AgentSession` 结构。差异只在于主 Agent 额外挂载编排工具：

```text
Main Agent
├── read / grep / find / ls
├── create_agent
├── spawn_agent
├── delegate
├── list_agents
├── get_agent_result
└── cancel_agent

Researcher / Coder / Reviewer
└── 根据各自 Profile 获得不同的项目工具和权限
```

主 Agent 的 Profile 默认具有：

- 读取项目和任务上下文的能力；
- 创建临时子 Agent 的能力；
- 调用已有 Profile 的能力；
- 汇总和验证子 Agent 结果的能力；
- 不直接修改业务代码的约束。

主 Agent 不能直接调用 `createAgentSession()`，也不能直接写入 Profile 存储。它只能通过本项目注册的工具提出创建或委派请求，由宿主完成校验、权限裁剪和审计。

### 3.3 Pi 适配边界

本项目只依赖 Pi 的公开 API：

- `createAgentSession`；
- `AgentSession` 的 `prompt`、`subscribe`、`steer`、`followUp`、取消和状态能力；
- `DefaultResourceLoader`；
- `SessionManager`；
- `SettingsManager`；
- `AgentTool` / 自定义工具注册能力；
- Pi Agent Core 的公开事件和工具生命周期 Hook。

所有 Pi 类型和版本差异集中在 `packages/pi-adapter`。不修改 Pi 源码，不依赖 Pi 私有模块，不让上层 Orchestrator 直接依赖 Pi 的内部事件名称。

### 3.4 系统边界

```text
┌──────────────────────────────────────────┐
│              用户 / Windows Client        │
└──────────────────┬───────────────────────┘
                   │ 用户请求、审批、查看结果
┌──────────────────▼───────────────────────┐
│              Main Agent / Orchestrator    │
│  分析任务、创建 Profile、调用子 Agent     │
└──────────────┬──────────────┬────────────┘
               │              │
        create_agent       delegate
               │              │
┌──────────────▼──────────────▼────────────┐
│       Agent Factory / Manager / Registry  │
│  校验、裁剪权限、分配 Session、管理生命周期 │
└──────────────┬──────────────┬────────────┘
               │              │
       临时 Pi Session   独立 Pi Worker
               │              │
┌──────────────▼──────────────▼────────────┐
│                 Pi Runtime                │
│ AgentSession / pi-agent-core / pi-ai      │
└──────────────────────────────────────────┘
```

执行形态分两阶段：

```text
MVP（同进程）
  一个 Node Worker 进程
  ├── Main Pi AgentSession
  ├── Researcher Pi AgentSession
  ├── Coder Pi AgentSession
  └── Reviewer Pi AgentSession

生产（独立 Worker）
  Control Plane
  ├── Main Agent Worker
  ├── Researcher Pi Worker
  ├── Coder Pi Worker
  └── Reviewer Pi Worker
```

两种形态都实现同一个 `AgentManager.run(profile, task)` 接口。MVP 先用同进程验证 Profile、工具和委派闭环；后续把 Session 执行替换成 Worker RPC 或容器，不改变主 Agent 工具协议。

### 3.5 Main Agent

负责：

- 理解用户请求；
- 判断是否需要子 Agent；
- 选择已有 Profile 或申请创建新 Profile；
- 生成结构化子任务；
- 读取子 Agent 结果；
- 决定是否重试、追加任务或进入下一个阶段；
- 向用户汇总最终结果。

Main Agent 不应直接绕过 Manager 创建 Pi Session，也不应直接向数据库写入 Agent Profile。主 Agent 的 `create_agent`、`spawn_agent` 和 `delegate` 必须由 Pi 的自定义工具机制注册到它的 Session 中。

### 3.6 Agent Factory

负责：

- 接收主 Agent 的 Profile 申请；
- 填充默认值；
- 校验字段和命名；
- 把请求的工具与宿主允许的工具求交集；
- 设置权限、资源和递归限制；
- 创建临时或持久 Profile；
- 记录创建原因和审计事件。

### 3.7 Agent Registry

负责：

- 注册和查找 Profile；
- 处理项目级、用户级和内置 Profile 的优先级；
- 版本管理；
- 启用、禁用和删除；
- 防止同名 Profile 覆盖；
- 为主 Agent 提供可调用角色目录。

### 3.8 Agent Manager

负责：

- 根据 Profile 创建 Pi AgentSession 或 Pi Worker；
- 注入职责 Prompt 和任务上下文；
- 安装经过裁剪的工具；
- 订阅 Pi 事件并转成平台事件；
- 控制暂停、恢复、取消和超时；
- 保存结果和 Session 引用；
- 执行输出契约校验。

---

## 4. AgentProfile 数据模型

### 4.1 Profile 请求模型

主 Agent 通过 `create_agent` 提交的请求不应直接等同于最终 Profile。请求先经过宿主校验和权限裁剪。

```ts
type AgentScope = "run" | "task" | "project" | "user";
type AgentPersistence = "ephemeral" | "persistent";
type AgentThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

interface CreateAgentRequest {
  name: string;
  description: string;
  responsibilities: string[];
  nonResponsibilities?: string[];
  systemPrompt?: string;
  requestedTools?: string[];
  readOnly?: boolean;
  requestedWritePaths?: string[];
  requestedModel?: string;
  thinkingLevel?: AgentThinkingLevel;
  outputContract?: OutputContract;
  canDelegate?: boolean;
  persistence?: AgentPersistence;
  scope?: AgentScope;
  reason: string;
  createdBy: "main-agent" | "user" | "system";
}
```

### 4.2 最终运行 Profile

```ts
interface AgentProfile {
  id: string;
  name: string;
  version: number;
  description: string;

  identity: {
    responsibilities: string[];
    nonResponsibilities: string[];
    systemPrompt: string;
  };

  execution: {
    model: string;
    thinkingLevel: AgentThinkingLevel;
    tools: string[];
    readOnly: boolean;
    writePaths: string[];
    canDelegate: boolean;
    maxDepth: number;
  };

  output: OutputContract;

  limits: {
    maxTurns: number;
    timeoutSeconds: number;
    maxCostUsd?: number;
    maxConcurrentChildren: number;
  };

  context: {
    includeParentSummary: boolean;
    includeTaskFiles: string[];
    loadProjectInstructions: boolean;
    memoryMode: "none" | "read" | "read-write";
  };

  lifecycle: {
    persistence: AgentPersistence;
    scope: AgentScope;
    createdBy: "main-agent" | "user" | "system";
    createdAt: string;
    expiresAt?: string;
  };
}
```

### 4.3 输出契约

第一版支持文本和 JSON 两类：

```ts
interface OutputContract {
  format: "text" | "json";
  schemaName?: string;
  requiredSections?: string[];
  requiredFields?: string[];
  acceptanceCriteriaRequired: boolean;
  reportChangedFiles: boolean;
  reportTests: boolean;
  reportRisks: boolean;
}
```

推荐内置契约：

```text
research-report
implementation-report
test-report
review-report
security-report
```

输出契约用于验证和展示，不应完全依赖模型自觉遵守。宿主至少要检查必要字段、任务状态、测试结果和修改文件清单。

---

## 5. Profile 来源与优先级

### 5.1 来源

```text
内置 Profile
用户级 Profile       ~/.multi-agent-dev/agents/<name>.yaml
项目级 Profile       .multi-agent-dev/agents/<name>.yaml
Run 临时 Profile      仅存在于当前 Run
Task 临时 Profile     仅存在于当前 Task
```

如果沿用 Pi 的资源约定，也可以同时支持：

```text
.pi/agents/<name>.md
~/.pi/agents/<name>.md
```

建议第一版使用独立的 `.multi-agent-dev/agents` 目录，因为 Agent Profile 不只是 Pi Skill，里面包含权限和资源限制，避免与普通 Skill 混淆。

### 5.2 优先级

```text
用户本次明确设置
  > 项目 Profile
  > 用户 Profile
  > 内置 Profile
  > 系统默认值
```

持久化 Profile 不允许被同名临时 Profile 静默覆盖。临时 Profile 使用独立 `agentId`，其 `name` 只作为显示名称。

### 5.3 Profile 命名规则

- 只能使用小写字母、数字、短横线和下划线；
- 长度限制为 1—64 个字符；
- 不允许使用 `main`、`system`、`admin` 等保留名称；
- 同一作用域内名称唯一；
- 持久 Profile 修改必须产生新版本；
- 已运行的 Agent 固定使用启动时的 Profile 快照，不被中途静默改变。

---

## 6. 主 Agent 工具协议

主 Agent 通过工具与 Agent Factory/Manager 交互，不能调用内部 TypeScript 方法。

### 6.1 `create_agent`

用途：申请创建一个临时或持久子 Agent。

请求示例：

```json
{
  "name": "react-performance-reviewer",
  "description": "负责分析 React 性能问题",
  "responsibilities": [
    "检查不必要的组件重渲染",
    "分析状态管理和数据流",
    "检查重复网络请求",
    "提出可以验证的优化建议"
  ],
  "nonResponsibilities": [
    "不修改业务代码",
    "不执行删除、提交或发布操作"
  ],
  "requestedTools": ["read", "grep", "find", "ls"],
  "readOnly": true,
  "requestedModel": "coding-balanced",
  "thinkingLevel": "high",
  "outputContract": {
    "format": "json",
    "schemaName": "review-report",
    "requiredFields": ["findings", "evidence", "recommendations"],
    "acceptanceCriteriaRequired": true,
    "reportChangedFiles": false,
    "reportTests": true,
    "reportRisks": true
  },
  "canDelegate": false,
  "persistence": "ephemeral",
  "scope": "task",
  "reason": "当前任务需要 React 性能专项分析",
  "createdBy": "main-agent"
}
```

返回示例：

```json
{
  "agentId": "agent_01JZ...",
  "name": "react-performance-reviewer",
  "status": "created",
  "persistence": "ephemeral",
  "effectiveProfile": {
    "tools": ["read", "grep", "find", "ls"],
    "readOnly": true,
    "writePaths": [],
    "model": "coding-balanced",
    "maxDepth": 0
  },
  "warnings": []
}
```

如果宿主裁剪了请求，返回结果必须说明：

```json
{
  "warnings": [
    "requested tool bash was removed because readOnly=true",
    "requested write path src was removed because this profile is read-only"
  ]
}
```

### 6.2 `delegate`

用途：调用一个已有的 Agent Profile 执行具体任务。

```json
{
  "agentId": "agent_01JZ...",
  "task": "分析当前项目的 React 性能问题",
  "context": {
    "files": ["src/", "package.json"],
    "parentSummary": "当前页面存在明显卡顿，怀疑与状态更新有关"
  },
  "acceptanceCriteria": [
    "列出具体问题及文件位置",
    "解释问题原因",
    "给出优化建议",
    "不要修改代码"
  ],
  "runMode": "foreground"
}
```

`runMode` 第一版支持：

```text
foreground  等待结果后继续主 Agent 当前回合
background  立即返回 taskId，主 Agent 后续用 get_agent_result 查询
parallel    与同一批其他只读子 Agent 并行执行
```

### 6.3 查询与控制工具

```text
list_agents
  列出当前作用域中可调用的 Agent

inspect_agent
  查看 Profile 的职责、有效工具和限制

get_agent_result
  获取子 Agent 的状态、最终输出和结构化报告

cancel_agent
  取消正在执行的子 Agent

update_agent
  仅允许更新主 Agent 创建的临时 Profile；持久 Profile 默认需要用户批准

delete_agent
  删除临时 Profile；持久 Profile 需要显式用户操作
```

### 6.4 `spawn_agent` 快捷工具

为了让主 Agent 能够自然地创建一次性专家，第一版额外提供组合工具 `spawn_agent`：

```text
spawn_agent = create_agent + delegate
```

它接收一个内嵌 Profile 申请和一个任务，宿主内部仍然先创建、校验和裁剪 Profile，再启动 Pi Session：

```json
{
  "profile": {
    "name": "sql-reviewer",
    "description": "检查 SQL 查询性能",
    "responsibilities": [
      "识别 N+1 查询",
      "检查缺少索引的高频查询",
      "给出文件位置和验证方法"
    ],
    "requestedTools": ["read", "grep", "find", "ls"],
    "readOnly": true,
    "persistence": "ephemeral"
  },
  "task": "分析当前项目的 SQL 查询"
}
```

返回值与 `delegate` 相同，但额外包含创建结果：

```json
{
  "agentId": "agent_01JZ...",
  "agentTaskId": "agent_task_01JZ...",
  "profileCreated": true,
  "status": "completed",
  "result": {
    "findings": [],
    "recommendations": []
  }
}
```

使用规则：

- `spawn_agent` 只允许创建临时 Agent；
- 持久 Profile 必须使用单独的 `create_agent` 流程并经过用户批准；
- `spawn_agent` 默认只允许低风险只读 Profile；
- 写入型一次性 Agent 必须显式提供任务的 `writePaths`，并经过任务和 Worker 权限校验；
- 组合工具内部产生和 `create_agent`、`delegate` 相同的审计事件。

---

## 7. 创建审批与权限裁剪

### 7.1 风险等级

Agent Factory 对创建请求计算风险：

```text
LOW
  只读工具、无网络、无子委派、临时生命周期

MEDIUM
  允许写入项目路径、允许 Bash、允许调用 MCP

HIGH
  允许访问项目外路径、允许网络凭据、允许递归创建子 Agent、持久化全局 Profile
```

### 7.2 默认策略

| 创建请求 | 默认行为 |
|---|---|
| 临时只读 Agent | 自动允许 |
| 临时可写 Agent | 进入宿主策略检查；必要时请求用户批准 |
| 持久项目 Agent | 默认需要用户批准 |
| 持久用户级 Agent | 必须用户明确批准 |
| 允许子 Agent 再创建 Agent | 默认拒绝，或深度为 0 |
| 访问外部目录 | 默认拒绝 |
| 使用任意 MCP | 必须经过 MCP 权限策略 |
| 使用 Bash | 继承 Worker 的命令权限和沙箱策略 |

### 7.3 有效权限求交集

最终能力必须是多个集合的交集：

```text
effectiveTools
  = requestedTools
  ∩ roleAllowedTools
  ∩ taskAllowedTools
  ∩ runtimeAvailableTools
  ∩ securityPolicyTools
```

写入路径同理：

```text
effectiveWritePaths
  = requestedWritePaths
  ∩ taskWritePaths
  ∩ workspaceBoundary
  ∩ securityPolicyPaths
```

无论模型如何修改 Prompt 或请求参数，都不能绕过这两个交集。

### 7.4 子 Agent 的递归策略

第一版默认：

```text
Main Agent depth = 0
普通子 Agent depth = 1
depth = 1 的子 Agent 不允许创建新的可写子 Agent
只读研究 Agent 可以继续创建只读 Agent，但总深度不超过配置上限
```

建议配置：

```ts
interface DelegationPolicy {
  canCreateAgents: boolean;
  maxDepth: number;
  allowedChildProfiles?: string[];
  maxConcurrentChildren: number;
  requiresApprovalForPersistentAgent: boolean;
}
```

---

## 8. Pi Runtime 集成

### 8.1 AgentFactory 创建方式

`AgentFactory` 是本项目 Agent 的唯一创建入口。它先生成有效 Profile，再通过 `PiSessionFactory` 创建 Session：

```ts
interface AgentFactory {
  createMainAgent(options: CreateMainAgentOptions): Promise<ManagedAgent>;
  createSubAgent(request: CreateAgentRequest, task: AgentTask): Promise<ManagedAgent>;
}

interface AgentManager {
  run(agentId: string, task: AgentTask): Promise<AgentResult>;
  runParallel(tasks: AgentTask[]): Promise<AgentResult[]>;
  cancel(agentTaskId: string): Promise<void>;
  getResult(agentTaskId: string): Promise<AgentResult | undefined>;
}
```

主 Agent 创建时挂载编排工具：

```ts
async function createMainAgent(options: CreateMainAgentOptions) {
  const mainProfile = profileRegistry.get("main");
  const orchestrationTools = [
    createAgentTool(agentFactory),
    spawnAgentTool(agentManager),
    delegateTool(agentManager),
    listAgentsTool(profileRegistry),
    getAgentResultTool(agentManager),
    cancelAgentTool(agentManager),
  ];

  return piSessionFactory.create({
    profile: mainProfile,
    task: options.initialTask,
    customTools: orchestrationTools,
  });
}
```

子 Agent 创建时不挂载这些工具，除非其有效 Profile 明确允许委派，并且通过递归策略检查。

### 8.2 Session 创建

Agent Manager 使用 Pi 的公开 SDK 创建 Session：

```ts
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

async function createPiSession(
  profile: AgentProfile,
  task: AgentTask,
  runtime: AgentRuntime,
) {
  const effectiveTools = runtime.policy.resolveTools(profile, task);
  const loader = new DefaultResourceLoader({
    cwd: runtime.workspace,
    agentDir: runtime.agentDir,
    systemPromptOverride: () => buildSystemPrompt(profile),
  });

  const { session } = await createAgentSession({
    cwd: runtime.workspace,
    model: runtime.resolveModel(profile.execution.model),
    thinkingLevel: profile.execution.thinkingLevel,
    tools: effectiveTools,
    resourceLoader: loader,
    sessionManager: runtime.createSessionManager(profile),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
    }),
  });

  return session;
}
```

职责和权限组成稳定 System Prompt；本次任务、父 Agent 摘要和验收标准作为动态任务消息单独传入：

```ts
async function runManagedAgent(agent: ManagedAgent, task: AgentTask) {
  await agent.session.prompt(buildTaskMessage(task));
  return resultCollector.collect(agent, task);
}
```

实现时必须以项目锁定的 Pi 版本实际导出类型为准，不能依赖私有 API。Pi 的版本升级必须通过 Adapter 层吸收。

### 8.3 工具权限拦截

工具列表裁剪是第一道防线，执行前拦截是第二道防线：

```ts
function authorizeToolCall(
  profile: AgentProfile,
  toolName: string,
  args: unknown,
): AuthorizationResult {
  if (!profile.execution.tools.includes(toolName)) {
    return { allowed: false, reason: "tool_not_granted" };
  }

  if (profile.execution.readOnly && isMutationTool(toolName)) {
    return { allowed: false, reason: "read_only_profile" };
  }

  if (isPathMutation(toolName, args)) {
    const paths = extractPaths(args);
    if (!paths.every((path) => isWithinAllowedPaths(path, profile.execution.writePaths))) {
      return { allowed: false, reason: "path_outside_profile_boundary" };
    }
  }

  return { allowed: true };
}
```

Pi Agent Core 的 `beforeToolCall` 或平台自己的 Tool Adapter 都可以用于执行检查，但最终路径和 Shell 沙箱必须由 Worker 宿主控制。

### 8.4 事件转换

Pi 事件必须统一转为平台事件，避免客户端依赖 Pi 内部事件名：

```text
Pi message_update          → agent_assistant_delta
Pi tool_execution_start    → agent_tool_started
Pi tool_execution_update   → agent_tool_progress
Pi tool_execution_end      → agent_tool_finished
Pi turn_start              → agent_turn_started
Pi turn_end                → agent_turn_finished
Pi agent_end               → agent_completed
abort/error                → agent_failed
```

每个事件至少包含：

```ts
interface AgentEventEnvelope {
  eventId: string;
  runId: string;
  taskId?: string;
  agentId: string;
  sessionId?: string;
  type: string;
  sequence: number;
  timestamp: string;
  payload: unknown;
}
```

### 8.5 临时 Agent 的 Session 策略

默认临时 Agent：

- 独立 Session；
- 独立上下文；
- 只接收必要的父任务摘要；
- 不直接继承主 Agent 全量对话；
- 任务完成后保留结果和事件摘要；
- 可配置是否保留完整 Session 文件；
- 生命周期结束后释放工具进程和运行资源。

这样可以避免把主 Agent 的全部历史重复塞进每个子 Agent，降低上下文和缓存成本。

---

## 9. Prompt 组装

职责 Prompt 要稳定，任务输入要动态追加，以提高模型 Prompt Cache 命中率。

推荐结构：

```text
[稳定前缀]
1. Agent 身份
2. 长期职责
3. 非职责
4. 工具说明
5. 输出契约
6. 安全与权限说明
7. 项目级固定指令

[动态任务尾部]
8. 本次任务
9. 父 Agent 摘要
10. 文件范围
11. 验收标准
12. 当前重试或修复信息
```

`create_agent` 产生的职责、工具和输出契约在 Session 创建后冻结。不能每一轮重新拼接一份不同的完整 System Prompt。

### 9.1 Prompt 模板

```md
# Identity
You are the {{name}} agent.

# Responsibilities
{{responsibilities}}

# Non-responsibilities
{{nonResponsibilities}}

# Effective capabilities
- Tools: {{tools}}
- Read only: {{readOnly}}
- Write paths: {{writePaths}}
- Can delegate: {{canDelegate}}

# Working rules
{{workingRules}}

# Output contract
{{outputContract}}
```

任务 Prompt 单独放在用户消息或任务上下文中：

```md
## Task
{{task}}

## Acceptance criteria
{{acceptanceCriteria}}

## Parent context
{{parentSummary}}
```

---

## 10. 生命周期与状态机

### 10.1 Profile 生命周期

```text
REQUESTED
  ↓ 校验
APPROVED
  ↓ 创建
REGISTERED
  ↓ 调用
ACTIVE
  ↓ 任务完成
IDLE
  ↓ 临时 Agent 到期
EXPIRED

REQUESTED → REJECTED
ACTIVE → CANCELLED
ACTIVE → FAILED
```

### 10.2 Agent Task 生命周期

```text
CREATED
  ↓
QUEUED
  ↓
STARTING
  ↓
RUNNING
  ├── WAITING_APPROVAL
  ├── WAITING_INPUT
  ├── PAUSED
  └── RETRYING
  ↓
COMPLETED / FAILED / CANCELLED / TIMED_OUT
```

### 10.3 生命周期要求

- 所有状态转换写入事件；
- 创建、调用、批准、拒绝、取消均有审计记录；
- 同一个 `agentTaskId` 只能有一个活跃执行；
- 重试必须产生新的 attempt 编号；
- 已完成 Agent 的结果不可被后续重试覆盖；
- 临时 Profile 的过期不能删除已产生的审计和结果；
- 主 Agent 取消时，默认级联取消它创建的活跃临时子 Agent。

---

## 11. 数据持久化

### 11.1 MVP 数据表

在现有规划的表基础上增加：

```text
agent_profiles
├── id
├── name
├── scope
├── persistence
├── version
├── description
├── profile_json
├── status
├── created_by
├── parent_agent_id
├── run_id
├── task_id
├── expires_at
├── created_at
└── updated_at

agent_profile_versions
├── id
├── agent_profile_id
├── version
├── profile_json
├── change_reason
├── created_by
└── created_at

agent_tasks
├── id
├── agent_profile_id
├── parent_agent_id
├── run_id
├── task_id
├── prompt_json
├── status
├── attempt
├── session_id
├── result_json
├── error_json
├── started_at
├── finished_at
└── created_at

agent_audit_events
├── id
├── run_id
├── task_id
├── agent_id
├── actor_type
├── action
├── request_json_redacted
├── result_json_redacted
├── created_at
└── request_id
```

### 11.2 文件 Profile

持久 Profile 的文件格式建议为 YAML frontmatter + Markdown：

```md
---
name: researcher
description: 负责代码阅读和技术调研
scope: project
model: coding-balanced
thinkingLevel: high
tools:
  - read
  - grep
  - find
  - ls
readOnly: true
canDelegate: false
outputContract: research-report
maxTurns: 20
---

# Responsibilities

- 阅读代码和官方文档
- 给出证据和文件位置
- 区分事实、推断和建议

# Non-responsibilities

- 不修改业务代码
- 不执行破坏性命令
```

文件只存非敏感配置。API Key、Cookie、OAuth Token 等一律不进入 Profile。

---

## 12. 典型调用流程

### 12.1 一次性专家

```text
1. Main Agent 识别任务需要专项能力
2. Main Agent 调用 create_agent
3. Factory 校验请求并裁剪权限
4. 返回 agentId 和 effectiveProfile
5. Main Agent 调用 delegate
6. Manager 创建独立 Pi Session
7. 子 Agent 执行任务
8. Manager 校验输出契约
9. 返回结构化结果
10. 临时 Profile 标记为 IDLE/EXPIRED
```

### 12.2 持久角色

```text
1. 用户要求保存角色，或通过设置页创建
2. Main Agent 调用 create_agent 提交持久化申请
3. 系统要求用户确认
4. Factory 保存 project/user scope Profile
5. 后续 Main Agent 通过 list_agents 查找
6. delegate 使用最新已批准版本
```

### 12.3 主 Agent 并行调用

```text
用户请求
  ↓
Main Agent
  ├── delegate(researcher, read-only)
  ├── delegate(architecture-reviewer, read-only)
  └── 等待两者结果
        ↓
  Main Agent 生成实现任务
        ↓
  delegate(coder, writable)
        ↓
  delegate(tester)
        ↓
  delegate(reviewer, read-only)
```

只有没有写入冲突的只读任务默认并行。可写 Agent 的并发仍由 Worktree、`writePaths` 和调度器校验。

---

## 13. 失败与恢复

### 13.1 创建失败

可能原因：

- 名称非法或冲突；
- 请求工具不存在；
- Profile 违反安全策略；
- 超出递归深度；
- 超出当前用户的 Agent 配额；
- 持久化操作未获用户批准。

处理方式：返回结构化错误，不自动降级为未受限 Agent。

### 13.2 执行失败

记录：

- `agentTaskId`；
- Profile 版本；
- Pi `sessionId`；
- attempt；
- 最后一个安全状态；
- 错误分类；
- Token 和成本；
- 已完成工具调用；
- 是否产生代码变更。

重试策略：

```text
只读调研失败       → 使用相同 Profile 重试一次
模型服务错误       → 走 fallback model
工具参数错误       → 把错误反馈给同一个 Session 重试
代码测试失败       → 生成修复任务，不无限重试
权限拒绝           → 暂停并请求用户，不自动绕过
```

### 13.3 主 Agent 失联

子 Agent Task 状态必须由 Control Plane 持久化。主 Agent 重新连接后可以：

- 查询自己创建的 Agent Task；
- 获取最终结果；
- 恢复未完成任务；
- 取消孤儿任务；
- 继续原 Run。

---

## 14. 与现有项目方案的衔接

现有项目规划中的固定角色仍然保留，但变成内置 Profile：

```text
backend     → 内置可写 Profile
frontend    → 内置可写 Profile
qa          → 内置测试 Profile
reviewer    → 内置只读 Profile
devops      → 高风险可写 Profile
docs        → 文档写入 Profile
```

主 Agent 动态创建的 Profile 不替代 Planner 输出的 Task DAG，而是用于填充任务执行能力：

```text
Planner 输出 Task DAG
  ├── task.role = backend
  ├── task.role = frontend
  └── task.role = 临时创建的 react-performance-reviewer
```

任务协议中的 `role` 应升级为：

```ts
interface TaskAgentBinding {
  profileId: string;
  profileVersion: number;
  createdForTask: boolean;
  requestedBy: "planner" | "main-agent" | "user";
}
```

这样任务启动后 Profile 版本固定，后台修改同名角色不会改变运行中的任务。

---

## 15. 第一阶段实现范围

### Phase A：Profile 与 Registry

- 定义 `AgentProfile`、`CreateAgentRequest`、`OutputContract`；
- 实现内置 Profile；
- 实现内存 Registry；
- 实现名称和字段校验；
- 实现工具白名单裁剪；
- 实现只读和路径边界校验。

验收：可以注册 `researcher`、`coder`、`reviewer`，并获得正确的有效工具集合。

### Phase B：Pi Session Adapter

- 实现 `PiSessionFactory`，封装 `createAgentSession`；
- 实现 `ManagedAgent`，统一 Profile、Session 和生命周期；
- 创建 Main Agent Session，并挂载编排工具；
- 创建 Sub Agent Session，并按 Profile 挂载业务工具；
- 注入 Profile Prompt；
- 将任务 Prompt 作为独立动态消息注入；
- 接入模型解析；
- 接入 Pi 事件转换；
- 实现取消、超时和结果收集。

验收：Main Agent 和一个 Sub Agent 都能通过 Profile 启动真实 Pi Session；Main Agent 可以调用一个自定义工具，子 Agent 可以完成一次任务。

### Phase C：`create_agent` 和 `delegate`

- 实现两个主 Agent 工具；
- 实现 `spawn_agent = create_agent + delegate` 组合工具；
- 实现临时 Profile 生命周期；
- 实现父子 Agent 关系；
- 实现同步和后台运行模式；
- 实现结果查询。

验收：主 Agent 可以通过 `spawn_agent` 创建 `react-performance-reviewer`，随后由 Agent Manager 创建独立 Pi Session 并得到结果。

### Phase D：持久化与审批

- `FileProfileStore` 保存项目级和用户级 Profile；
- `PersistentProfileService` 只接受宿主批准的持久化请求；
- 普通 `AgentFactory` 默认拒绝持久 Profile，Main Agent 工具不暴露持久化工具；
- 保存失败时回滚 Registry 注册，删除时校验磁盘 Profile 的 `id/version`；
- Profile 版本写入 `.versions/<profile>/v<version>.json`，加载时按作用域覆盖。

验收：用户批准后可以在下一次 Run 中复用持久 Profile；未批准时不会注册或落盘，保存失败时不会留下半注册 Profile。

### Phase E：并行与 Worker

- 接入现有 Task DAG；
- 只读 Agent 并行；
- 可写 Agent 绑定 Worktree；
- 加入并发、成本和递归限制；
- 接入 Control Plane 和 WebSocket。

验收：主 Agent 可以同时调用两个只读专家，再把结果交给一个 Coder Agent。

---

## 16. MVP 验收标准

- [ ] 主 Agent 能调用 `create_agent` 创建临时 Agent；
- [ ] Main Agent 本身通过 Profile + Pi AgentSession 创建；
- [ ] Main Agent 拥有 `create_agent`、`spawn_agent` 和 `delegate` 编排工具；
- [ ] Sub Agent 通过同一个 Pi Adapter 创建，不为每个角色实现独立 Agent 类；
- [ ] 创建请求经过 Schema 校验；
- [ ] 主 Agent 不能通过 Profile 请求绕过宿主权限；
- [ ] `readOnly=true` 的 Agent 实际无法调用写工具；
- [ ] 写入路径经过 workspace 和 `writePaths` 双重校验；
- [ ] Agent 创建后返回有效 Profile 快照和裁剪警告；
- [ ] 主 Agent 能通过 `delegate` 调用刚创建的 Agent；
- [ ] 主 Agent 能通过 `spawn_agent` 完成创建和调用的一体化流程；
- [ ] 子 Agent 使用独立 Pi Session；
- [ ] 子 Agent 只接收必要的父任务摘要；
- [ ] Pi 事件可以统一转成平台 Agent 事件；
- [ ] 子 Agent 结果包含状态、输出、测试和错误信息；
- [ ] 子 Agent 超时、取消和失败可以被主 Agent 查询；
- [ ] 临时 Agent 到期后不再可调用，但审计和结果保留；
- [ ] 持久 Profile 默认需要用户批准；
- [ ] 持久 Profile 修改产生新版本；
- [ ] 已运行任务继续使用启动时的 Profile 快照；
- [ ] 子 Agent 递归深度和并发数有硬限制；
- [ ] API Key、Token 和敏感环境变量不进入 Profile 和普通日志；
- [ ] 有针对 Profile 校验、权限裁剪、生命周期和调用闭环的测试。

---

## 17. 推荐目录结构

在现有项目目录结构基础上增加：

```text
packages/
├── agent-contracts/
│   ├── profile.ts
│   ├── task.ts
│   ├── result.ts
│   └── events.ts
├── agent-registry/
│   ├── registry.ts
│   ├── profile-loader.ts
│   ├── profile-validator.ts
│   └── profile-versioning.ts
├── agent-factory/
│   ├── factory.ts
│   ├── capability-policy.ts
│   ├── permission-capper.ts
│   └── approval-policy.ts
├── pi-adapter/
│   ├── session-factory.ts
│   ├── managed-agent.ts
│   ├── pi-event-adapter.ts
│   ├── pi-tool-guard.ts
│   └── model-resolver.ts
├── agent-manager/
│   ├── manager.ts
│   ├── task-runner.ts
│   ├── lifecycle.ts
│   ├── result-validator.ts
│   └── concurrency.ts
└── orchestrator/
    ├── main-agent-factory.ts
    ├── main-agent-tools.ts
    ├── spawn-agent-tool.ts
    ├── delegate-tool.ts
    ├── create-agent-tool.ts
    └── delegation-graph.ts

multi-agent-runtime/
├── main-agent.ts
├── subagent-runtime.ts
└── worker-rpc.ts

.multi-agent-dev/
└── agents/
    ├── main.md
    ├── researcher.md
    ├── coder.md
    └── reviewer.md
```

其中 `main-agent.ts` 只负责组装 Main Agent Profile 和编排工具；实际 Pi Session 创建仍统一经过 `pi-adapter/session-factory.ts`。

---

## 18. 关键设计决策

### 决策 1：先实现临时 Agent，再实现持久 Agent

临时 Agent 可以验证“主 Agent 创建并调用子 Agent”的核心闭环，复杂度和风险较低。持久化涉及版本、审批、作用域、冲突和迁移，应放在第二阶段。

### 决策 2：Profile 与 Skill 分离

Skill 是一套工作方法；Profile 是一个独立运行身份。Profile 可以加载 Skill，但 Skill 不能替代 Profile 的权限和生命周期。

### 决策 3：使用 Profile 快照

Agent 启动时复制 Profile 版本。运行期间不读取动态配置，避免后台修改造成行为漂移。

### 决策 4：Main Agent 与 Sub Agent 使用同一个 Pi Agent Runtime

主 Agent 不是特殊的第二套框架，而是一个拥有额外编排工具的 Pi Agent。所有角色都通过 `AgentProfile + Pi AgentSession` 创建，差异由 Profile 和工具集合决定。

### 决策 5：所有主 Agent 能力通过工具暴露

`create_agent`、`spawn_agent`、`delegate`、`list_agents` 都作为主 Agent 可见工具注册，宿主统一做参数校验、权限、审计和事件持久化。

### 决策 6：第一版禁止普通子 Agent 递归创建可写子 Agent

递归委派很有价值，但会显著增加成本、状态和安全复杂度。先允许 Main Agent 创建和调用；后续仅对可信只读研究 Agent 开放有限递归。

---

## 19. 最终工作流

```text
用户请求
   ↓
Main Agent 理解任务
   ↓
查询已有 Profile
   ├── 找到合适角色 → delegate
   └── 没有合适角色 → spawn_agent
                          ↓
                    Factory 校验和裁剪
                          ↓
                    返回有效 agentId
                          ↓
                    delegate(agentId, task)
                          ↓
                    Agent Manager
                          ↓
                    独立 Pi Session
                          ↓
                    工具调用 / 测试 / 报告
                          ↓
                    结果契约校验
                          ↓
                    Main Agent 汇总或继续委派
```

最终抽象为：

```text
Main Agent
  = Agent Factory + Orchestrator

AgentProfile
  = 职责 + 工具 + 权限 + 模型 + 输出契约 + 资源限制

AgentManager
  = Profile 快照 + Pi Session + 生命周期 + 事件 + 结果

Agent Registry
  = 内置角色 + 用户角色 + 项目角色 + 临时角色
```

这套设计既支持“主 Agent 临时创建专家并立即调用”，也支持把有效职责沉淀成可以重复调用的长期角色，同时不把安全和权限控制交给模型自行决定。

---

## 20. 当前实现状态

截至 2026-07-31，仓库已完成第一版运行时骨架：

```text
已完成
  AgentProfile / AgentTask / AgentResult / AgentEvent Contracts
  Profile 校验、Registry 和同作用域冲突检查
  工具能力求交集、只读裁剪和 workspace/writePaths 边界检查
  AgentFactory 动态 Profile 创建
  researcher / coder / tester / reviewer 内置 Profile
  Pi 0.83.0 PiSessionFactory
  Pi ModelRuntime 接口、ModelGateway 路由和宿主凭据解析边界
  ManagedAgent、PiAgentManager 和结果管理
  PiAgentManager 有界 FIFO 任务队列、排队快照、排队取消和全局并发上限
  PassthroughWorkspaceProvider/GitWorktreeProvider 工作区 Lease 和失败清理
  Manager 级 AgentEvent 事件桥和生命周期事件
  Agent 超时覆盖 prompt/idle 等待、最大回合限制和父 Agent 并发子任务限制
  AgentResult token/cost 用量统计、Profile maxCostUsd 硬上限和超限中止
  失败/取消/超时任务重试、attempt 递增和已完成结果保护
  FileAgentEventStore JSONL 事件持久化和敏感字段脱敏
  FileAgentTaskStore 任务状态/结果快照、Profile/执行快照和新 Manager 实例恢复
  AgentControlPlane v1 DTO、Profile/Task/Result 查询、任务提交、取消和事件订阅
  AgentControlPlane retry_agent 失败/取消/超时/孤儿任务跨进程重试命令
  ControlPlaneHttpServer HTTP JSON/SSE transport、回环默认绑定和鉴权钩子
  ControlPlaneWebSocketServer WebSocket request/response、事件推送、鉴权和背压限制
  ControlPlaneWorkerRpcServer/Client Worker JSONL RPC、鉴权、帧边界和断开处理
  ControlPlaneWorkerProcess Worker 子进程启动、RPC 握手、停止超时和异常退出管理
  项目/用户级 FileProfileStore、版本快照和显式审批边界
  Pi faux Provider 驱动的 Main Agent → spawn_agent → Sub Agent 真实回合测试
  MainAgentFactory
  create_agent / spawn_agent / delegate / list_agents / get_agent_result / cancel_agent 工具定义
  Runtime Bootstrap

  尚未完成
  外部 Provider Gateway、模型配置中心和真实 API Key 管理服务
  真实 Provider 驱动的主 Agent 请求端到端闭环
  Worker 进程的分布式队列调度和容器隔离
```

当前验证命令：

```bash
npm run typecheck
npm test
```

测试不需要 API Key；其中包含真实 `createAgentSession` 创建烟测，以及使用 Pi faux Provider 的 Main Agent → `spawn_agent` → Sub Agent 真实 Agent Loop 回合，不访问外部模型服务。持久 Profile 已支持项目/用户作用域、宿主显式批准、版本快照、保存失败回滚和批准删除；Agent Manager 已执行超时、最大回合、父 Agent 并发限制和全局 FIFO 队列；AgentResult 已记录 token/cost 用量，Profile maxCostUsd 超限会中止 Session；ModelGateway 已提供模型路由和宿主凭据注入边界；FileAgentEventStore 已提供 JSONL 事件持久化和脱敏；FileAgentTaskStore 已支持 Profile/执行快照、结果恢复和新 Manager 跨进程重试；AgentControlPlane 已提供 v1 transport-neutral 协议、宿主约束的后台任务提交、结果查询和恢复重试；ControlPlaneHttpServer 已提供回环 HTTP JSON/SSE transport 和鉴权钩子；ControlPlaneWebSocketServer 已提供双向 JSON transport、事件推送和连接背压；ControlPlaneWorkerRpcServer/Client 已提供跨进程 JSONL RPC、鉴权、帧大小限制和断开处理；ControlPlaneWorkerProcess 已提供宿主侧 Worker 子进程生命周期管理；GitWorktreeProvider 已提供可写 Agent 的隔离工作区和释放清理。下一步应接入分布式任务 claim/租约、全局配额与成本治理、外部 Provider Gateway、Worker 分布式调度和容器隔离。
