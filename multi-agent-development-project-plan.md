# 多 Agent 并行开发平台方案企划书

> 版本：v0.1
>
> 日期：2026-07-30
>
> 用途：交给 Codex 作为项目实现依据；本文件定义第一阶段 MVP 的产品目标、技术架构、数据协议、开发边界和验收标准。

---

## 1. 项目概述

### 1.1 项目名称

暂定名：**Multi-Agent Dev**

中文名：**多 Agent 并行开发平台**

### 1.2 项目定位

一个面向团队的软件开发协作平台：用户提交自然语言开发需求后，由主 Agent 自动分析并拆解为结构化子任务，再由多个子 Agent 基于 Pi Agent Runtime 并行执行代码开发、测试和审查。用户通过 Windows 客户端查看任务图、Agent 状态、实时日志、代码 Diff、测试结果，并能够在后台为不同 Agent 角色配置或切换大模型。

### 1.3 核心价值

- 将一个大型开发需求拆解为多个可并行执行的工程任务；
- 通过 Git worktree 或独立工作区隔离子 Agent 的代码修改；
- 让不同角色使用不同模型：Planner、Backend、Frontend、QA、Reviewer 等；
- 通过后台统一管理 Provider、API 地址、模型、密钥和并发限制；
- 通过 Windows EXE 提供可视化控制入口；
- 保留人工审批、暂停、继续、重试和合并能力，避免全自动失控。

---

## 2. 产品目标与非目标

### 2.1 第一阶段目标（MVP）

用户能够完成以下闭环：

1. 登录 Windows 客户端；
2. 创建或选择一个 Git 项目；
3. 输入一条开发需求；
4. 主 Agent 输出结构化任务 DAG；
5. 系统创建 2—4 个可并行的子任务；
6. 每个子任务启动一个独立 Pi Worker；
7. 每个 Worker 使用独立 Git worktree；
8. 客户端实时展示 Agent 状态和日志；
9. Worker 编码、运行测试并提交 commit；
10. 系统展示 Diff 和测试结果；
11. Integrator Agent 或人工将任务结果合并到集成分支；
12. 管理员在后台修改角色模型配置，新任务使用新配置；
13. 运行中的任务支持在当前 Turn 完成后切换模型或重新启动 Session。

### 2.2 第一阶段明确不做

- 不直接自动部署到生产环境；
- 不自动修改生产数据库；
- 不实现复杂计费系统；
- 不实现多集群调度；
- 不实现无限递归 Agent；
- 不让多个 Worker 无限制共享同一工作目录；
- 不把完整 API Key 返回给客户端；
- 不把所有逻辑塞进 Windows 客户端；
- 不在第一版追求多个客户端平台；
- 不把“自然语言任务”直接当成可执行指令，必须先经过结构化任务协议。

---

## 3. 产品形态

系统由三部分组成：

```text
Windows 客户端 EXE
    ↓ HTTPS + WebSocket
服务端 Control Plane
    ↓ 任务队列 / Worker 协议
Pi Worker 执行环境
```

### 3.1 Windows 客户端

负责：

- 登录和服务端连接；
- 项目管理；
- 需求提交；
- 任务 DAG 展示；
- Agent 状态和日志展示；
- Git Diff 和测试结果展示；
- 暂停、继续、取消、重试；
- 模型配置页面；
- 运行中的模型切换请求；
- 断线重连和状态恢复。

客户端不负责：

- 保存服务端完整 API Key；
- 直接调模型 API；
- 直接控制数据库；
- 承担全局任务调度；
- 在 Renderer 进程直接执行任意 Shell 命令。

### 3.2 服务端 Control Plane

负责：

- 用户认证和权限；
- 项目、Run、Task、Agent Session 管理；
- Planner 调用；
- 任务 DAG 解析和调度；
- 模型配置和模型路由；
- Worker 生命周期管理；
- 日志、事件和 Token 统计；
- Git worktree 管理；
- Integrator、Review 和合并流程；
- WebSocket 实时事件广播。

### 3.3 Pi Worker

每个 Worker 是独立进程或容器，负责：

- 读取任务协议；
- 加载指定模型；
- 调用 Pi Agent Runtime；
- 读取和修改指定工作区；
- 执行允许的工具；
- 运行测试；
- 上报工具调用、日志、状态和结果；
- 提交 commit；
- 响应暂停、继续、取消和模型切换指令。

---

## 4. 总体技术架构

```text
┌──────────────────────────────────────────────┐
│              Windows Desktop EXE             │
│ React + Electron + TypeScript                 │
│ Project / Run / DAG / Logs / Diff / Settings  │
└──────────────────────┬───────────────────────┘
                       │ HTTPS + WebSocket
┌──────────────────────▼───────────────────────┐
│                 Control Plane API             │
│ Auth / Project / Run / Task / Agent / Model   │
│ REST API / WebSocket / Event Bus              │
└──────────────┬───────────────┬────────────────┘
               │               │
               ▼               ▼
┌────────────────────┐  ┌──────────────────────┐
│ Orchestrator       │  │ Model Gateway         │
│ Planner / DAG      │  │ Provider / Key /      │
│ Scheduler / Retry   │  │ Routing / Usage       │
└──────────┬─────────┘  └──────────┬───────────┘
           │                       │
           ▼                       ▼
┌────────────────────┐  ┌──────────────────────┐
│ Worker Manager     │  │ OpenAI / Anthropic /  │
│ Pi Process/Container│  │ Gemini / Compatible  │
└──────────┬─────────┘  └──────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────┐
│ Pi Worker 1 / Pi Worker 2 / Pi Worker N      │
│ Independent Session + Workspace + Git Branch │
└──────────────────────────────────────────────┘
```

### 4.1 推荐技术栈

#### 服务端

- Node.js 20+；
- TypeScript；
- Fastify；
- PostgreSQL；
- Drizzle ORM 或 Prisma；
- Redis；
- BullMQ（如果第一版需要可靠队列）；
- WebSocket；
- Zod 或 TypeBox 做协议校验。

#### Agent Runtime

- Pi Agent Core；
- Pi AI Provider 层；
- TypeScript Worker；
- Git worktree；
- Docker/Podman 作为后续隔离执行方案。

#### Windows 客户端

- Electron；
- React；
- TypeScript；
- Vite；
- React Flow；
- xterm.js；
- Monaco Editor Diff；
- TanStack Query；
- Zustand 或 Redux Toolkit；
- electron-builder；
- NSIS Installer。

#### 基础设施

- Docker Compose；
- PostgreSQL；
- Redis；
- 可选 MinIO（日志、构建产物和附件）。

---

## 5. Agent 角色设计

### 5.1 Planner / 主 Agent

职责：

- 阅读用户需求；
- 分析项目结构；
- 识别任务依赖；
- 拆解任务；
- 指定角色和模型 Profile；
- 指定工作目录和允许修改路径；
- 输出验收标准；
- 在所有任务完成后生成汇总报告；
- 决定是否需要 Review 或重试。

Planner 不直接修改业务代码。MVP 中 Planner 可以读取仓库，但输出必须是符合 Schema 的 JSON。

### 5.2 Worker Agent

角色至少包括：

- `backend`：后端接口、服务、数据层；
- `frontend`：页面、组件、交互；
- `qa`：测试、回归、质量验证；
- `reviewer`：只读审查；
- `devops`：构建、CI、部署配置；
- `docs`：文档和示例。

### 5.3 Integrator Agent

职责：

- 读取已完成 Worker 的 commit 和任务报告；
- 按依赖顺序合并到集成分支；
- 处理简单冲突；
- 运行完整测试；
- 输出合并报告；
- 对复杂冲突转人工处理。

---

## 6. 任务协议设计

Planner 必须输出结构化 DAG，不允许只输出自然语言。

```json
{
  "goal": "为后台增加团队成员管理功能",
  "tasks": [
    {
      "id": "task_backend_members",
      "title": "实现团队成员管理 API",
      "role": "backend",
      "dependsOn": [],
      "modelProfile": "backend-default",
      "writePaths": [
        "server/modules/members",
        "server/routes"
      ],
      "acceptanceCriteria": [
        "实现成员列表接口",
        "实现新增成员接口",
        "实现删除成员接口",
        "补充 API 测试"
      ],
      "testCommands": [
        "npm test -- members"
      ]
    },
    {
      "id": "task_frontend_members",
      "title": "实现团队成员管理页面",
      "role": "frontend",
      "dependsOn": [
        "task_backend_members"
      ],
      "modelProfile": "frontend-default",
      "writePaths": [
        "web/src/pages/members",
        "web/src/components/members"
      ],
      "acceptanceCriteria": [
        "显示成员列表",
        "支持新增成员",
        "支持删除确认",
        "显示接口错误状态"
      ],
      "testCommands": [
        "npm test -- members-page"
      ]
    }
  ]
}
```

### 6.1 任务约束

- `id` 在一个 Run 内唯一；
- `dependsOn` 不得形成环；
- `writePaths` 不应互相重叠；
- 全工作区写入任务默认串行；
- 任务必须包含验收标准；
- 任务必须指定角色；
- 任务必须指定模型 Profile 或由角色继承默认 Profile；
- Planner 输出不符合 Schema 时，Run 进入 `PLANNING_FAILED`，不得直接启动 Worker。

---

## 7. 状态机

### 7.1 Run 状态

```text
CREATED
  ↓
PLANNING
  ↓
READY
  ↓
RUNNING
  ↓
INTEGRATING
  ↓
REVIEWING
  ↓
SUCCEEDED / FAILED / CANCELLED
```

### 7.2 Task 状态

```text
PENDING
  ↓ 依赖满足
READY
  ↓ 调度
RUNNING
  ↓
TESTING
  ↓
SUCCEEDED

RUNNING → WAITING_INPUT
RUNNING → FAILED
READY/RUNNING → CANCELLED
```

### 7.3 Worker 状态

```text
CREATED
STARTING
RUNNING
WAITING_INPUT
TESTING
COMPLETED
FAILED
STOPPED
```

所有状态转移必须写入事件表，不能只依赖内存状态。

---

## 8. 模型配置中心

### 8.1 Provider 配置

```text
providers
├── id
├── name
├── kind
├── base_url
├── api_key_secret_ref
├── enabled
├── created_at
└── updated_at
```

### 8.2 Model Profile

```text
model_profiles
├── id
├── name
├── provider_id
├── model_name
├── context_window
├── max_output_tokens
├── reasoning_effort
├── timeout_seconds
├── max_concurrency
├── retry_limit
├── enabled
├── version
├── created_at
└── updated_at
```

### 8.3 Agent Role Binding

```text
agent_role_bindings
├── role
├── model_profile_id
├── fallback_model_profile_id
├── priority
└── enabled
```

示例：

```text
planner   → coding-strong
backend   → coding-balanced
frontend  → coding-fast
qa        → coding-balanced
reviewer  → coding-strong
```

### 8.4 密钥安全

- API Key 不发送到客户端；
- API Key 加密存储或使用 Secret Manager；
- 日志中自动脱敏；
- Worker 只获取本次请求所需的短时配置；
- 不把 Key 放到 Prompt、Git、数据库普通日志中；
- 配置接口只返回脱敏值；
- 支持密钥轮换；
- 删除密钥后旧 Worker 不得继续无限使用旧 Key。

### 8.5 模型切换策略

MVP 采用：

```text
新任务：立即使用新配置
未启动任务：启动时读取新配置
运行中任务：当前 Turn 结束后切换
```

如果 Pi Agent Runtime 无法安全地原地替换模型：

```text
停止当前 Turn
保存 Session / Context
重新解析模型
重新创建 Pi Agent
恢复上下文
继续执行
```

不得强行修改 Pi 内部私有状态。

---

## 9. Git 与工作区隔离

每个 Task 必须有独立工作区：

```text
project/
├── main
└── .worktrees/
    ├── task_backend_members
    ├── task_frontend_members
    └── task_qa_members
```

工作区记录：

```text
workspaces
├── id
├── project_id
├── task_id
├── branch_name
├── path
├── base_commit
├── status
├── created_at
└── cleaned_at
```

Worker 完成时必须输出：

- commit SHA；
- 修改文件列表；
- 测试命令；
- 测试结果；
- 失败原因；
- 任务完成摘要。

MVP 推荐 Integrator 分支策略：

```text
main
  ↓
integration/<run-id>
  ↓ 合并各 Worker commit
  ↓ 运行完整测试
  ↓ 人工确认或生成 PR
```

---

## 10. Worker 与 Pi 的集成

Worker 不应在 Electron Renderer 内运行。推荐：

```text
Control Plane
    ↓ Worker Job
Worker Manager
    ↓
独立 Node 进程或 Docker 容器
    ↓
Pi Agent Core
```

Worker 初始化参数示例：

```json
{
  "runId": "run_001",
  "taskId": "task_backend_members",
  "role": "backend",
  "workspace": "/workspaces/project/task_backend_members",
  "modelProfileId": "backend-default",
  "prompt": "实现团队成员管理 API",
  "maxTurns": 40,
  "timeoutSeconds": 3600,
  "writePaths": ["server/modules/members", "server/routes"]
}
```

Worker 必须订阅并上报：

- `worker_started`；
- `turn_started`；
- `assistant_delta`；
- `tool_call_started`；
- `tool_call_finished`；
- `test_started`；
- `test_finished`；
- `model_switch_requested`；
- `worker_waiting_input`；
- `worker_completed`；
- `worker_failed`。

---

## 11. 客户端 EXE 方案

### 11.1 技术选型

第一版采用：

```text
Electron + React + TypeScript + Vite
```

打包工具：

```text
Electron Builder + NSIS
```

产物：

```text
Multi-Agent-Dev-Setup.exe
Multi-Agent-Dev-Portable.exe
```

### 11.2 Electron 安全要求

- 开启 `contextIsolation`；
- 开启 `sandbox`（可以按 Worker 集成需要评估）；
- Renderer 禁止直接使用 Node API；
- 所有本地能力通过 `preload.ts` 白名单暴露；
- 禁止通过 IPC 执行任意命令；
- 服务端 URL 使用 HTTPS；
- Token 使用 Electron safeStorage 或 Windows Credential Manager；
- 客户端日志禁止打印 API Key；
- 自动更新包必须校验签名或使用可信发布源。

### 11.3 客户端页面

MVP 页面：

1. 登录页；
2. 项目列表；
3. Run 创建页；
4. 任务 DAG 页；
5. Agent 详情页；
6. 实时日志页；
7. Diff 和测试结果页；
8. 模型配置页；
9. 系统设置页。

### 11.4 WebSocket 事件

```json
{
  "type": "task_status_changed",
  "runId": "run_001",
  "taskId": "task_backend_members",
  "status": "RUNNING",
  "timestamp": "2026-07-30T06:00:00Z",
  "payload": {}
}
```

客户端必须：

- 自动重连；
- 断线后重新获取 Run 快照；
- 按 `eventId` 去重；
- 不把事件顺序完全交给网络到达顺序；
- 显示最后更新时间；
- 在服务端状态和本地缓存冲突时以服务端快照为准。

---

## 12. 推荐目录结构

```text
multi-agent-dev/
├── apps/
│   ├── desktop/
│   │   ├── electron/
│   │   │   ├── main.ts
│   │   │   ├── preload.ts
│   │   │   └── ipc/
│   │   └── renderer/
│   │       ├── pages/
│   │       ├── components/
│   │       ├── stores/
│   │       ├── api/
│   │       └── websocket/
│   ├── api/
│   │   ├── src/modules/
│   │   │   ├── auth/
│   │   │   ├── projects/
│   │   │   ├── runs/
│   │   │   ├── tasks/
│   │   │   ├── agents/
│   │   │   ├── models/
│   │   │   ├── workspaces/
│   │   │   └── events/
│   │   └── migrations/
│   ├── planner/
│   │   └── src/
│   └── worker/
│       └── src/
│           ├── pi-worker.ts
│           ├── worker-runtime.ts
│           ├── model-resolver.ts
│           ├── workspace-manager.ts
│           └── event-reporter.ts
├── packages/
│   ├── contracts/
│   ├── orchestrator/
│   ├── pi-adapter/
│   ├── model-gateway/
│   ├── git-worktree/
│   └── event-protocol/
├── infra/
│   └── docker-compose.yml
├── docs/
│   ├── architecture.md
│   ├── task-protocol.md
│   ├── model-routing.md
│   └── security.md
└── package.json
```

---

## 13. REST API 草案

### 项目

```http
GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId
DELETE /api/projects/:projectId
```

### Run

```http
POST /api/projects/:projectId/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/graph
POST /api/runs/:runId/cancel
POST /api/runs/:runId/retry
```

创建 Run：

```json
{
  "prompt": "给后台增加团队成员管理功能",
  "maxParallel": 4,
  "plannerModelProfileId": "planner-default"
}
```

### Task

```http
GET  /api/runs/:runId/tasks
GET  /api/tasks/:taskId
POST /api/tasks/:taskId/pause
POST /api/tasks/:taskId/resume
POST /api/tasks/:taskId/cancel
POST /api/tasks/:taskId/retry
POST /api/tasks/:taskId/model
GET  /api/tasks/:taskId/diff
GET  /api/tasks/:taskId/logs
```

切换模型：

```json
{
  "modelProfileId": "coding-strong",
  "effectiveAt": "next_turn"
}
```

### 模型

```http
GET    /api/model-profiles
POST   /api/model-profiles
GET    /api/model-profiles/:id
PATCH  /api/model-profiles/:id
DELETE /api/model-profiles/:id
POST   /api/model-profiles/:id/test
GET    /api/agent-role-bindings
PUT    /api/agent-role-bindings/:role
```

### WebSocket

```text
WS /api/runs/:runId/events
```

---

## 14. 数据库核心表

```text
users
projects
project_members
runs
run_tasks
task_dependencies
agent_sessions
agent_events
worker_jobs
workspaces
providers
model_profiles
agent_role_bindings
usage_records
artifacts
review_records
integration_records
```

### 14.1 幂等与审计

- 所有外部命令需要 `requestId`；
- Worker 上报事件需要 `eventId`；
- 事件消费必须幂等；
- Task 状态更新需要版本号或乐观锁；
- 同一个 Task 不允许被两个调度器同时 Claim；
- 所有模型配置修改必须记录审计日志；
- 所有 Worker 控制操作必须记录操作者和时间。

---

## 15. 第一阶段开发计划

### Phase 0：项目骨架

- 初始化 Monorepo；
- 建立 `apps` 和 `packages`；
- 定义共享 TypeScript Contracts；
- 配置 ESLint、Prettier、测试和 CI；
- 启动 PostgreSQL、Redis；
- 完成健康检查接口。

验收：`npm test`、`npm run typecheck` 和服务启动成功。

### Phase 1：Pi Worker

- 封装 Pi Agent Core；
- 实现单个 Worker 的启动、Prompt、工具事件和结果上报；
- 实现模型 Profile 解析；
- 实现 Worker 取消和超时；
- 写 Worker 单元测试。

验收：一个 Worker 能在测试项目中完成简单代码修改并返回 commit 信息。

### Phase 2：Git Worktree

- 实现 Worktree 创建；
- 实现分支命名；
- 实现 Worktree 清理；
- 实现工作区与 Task 绑定；
- 增加路径冲突校验。

验收：两个 Worker 能在同一个仓库中并行修改不同目录而互不覆盖。

### Phase 3：Planner 与 DAG

- 实现 Planner Prompt；
- 定义并校验任务 JSON Schema；
- 实现 DAG 环检测；
- 实现任务依赖解析；
- 实现 READY 任务生成。

验收：自然语言需求能生成合法 DAG，非法 DAG 被拒绝。

### Phase 4：调度器

- 实现 Task Claim；
- 实现最大并发限制；
- 实现 Worker 启动；
- 实现重试和失败状态；
- 实现任务取消。

验收：2—4 个 Worker 可以并行运行，单个 Worker 失败不影响其他无依赖任务。

### Phase 5：API 与 WebSocket

- 实现项目、Run、Task 接口；
- 实现事件持久化；
- 实现 WebSocket 广播；
- 实现断线重连和 Run 快照。

验收：客户端或测试脚本可以实时看到完整事件链。

### Phase 6：Windows 客户端

- 初始化 Electron + React；
- 完成登录；
- 完成项目列表；
- 完成需求提交；
- 完成 DAG；
- 完成日志；
- 完成 Diff；
- 完成暂停、继续、取消。

验收：Windows EXE 安装后可以完成完整 MVP 流程。

### Phase 7：模型管理

- Provider CRUD；
- Model Profile CRUD；
- 角色模型绑定；
- Key 脱敏和加密；
- 运行中任务下一轮切换；
- Usage 统计。

验收：管理员修改 Worker 角色模型后，新任务使用新模型；运行中任务按策略切换。

### Phase 8：集成与 Review

- Integrator Agent；
- 集成分支；
- 自动运行完整测试；
- Diff Review；
- 人工批准合并。

验收：多个 Worker 的 commit 能按依赖顺序集成，并输出最终报告。

---

## 16. 安全设计

### 16.1 身份与权限

MVP 至少包含：

- 用户登录；
- 项目成员；
- Owner、Admin、Developer、Viewer 四种角色；
- 模型配置只允许 Admin 修改；
- 删除项目、取消 Run、强制结束 Worker 需要权限；
- 生产环境相关操作默认关闭。

### 16.2 Worker 隔离

- 独立工作区；
- 独立 Session；
- 路径访问限制；
- 命令超时；
- CPU 和内存限制；
- 可选 Docker 沙箱；
- 不允许 Worker 读取其他项目的凭证；
- 不允许把服务端 Secret 注入 Prompt；
- 记录所有高风险工具调用。

### 16.3 客户端安全

- HTTPS；
- Token 安全存储；
- Electron contextIsolation；
- IPC 白名单；
- 自动更新签名；
- 客户端不接收完整 API Key；
- 日志脱敏；
- 错误信息不泄露服务端密钥和内部路径。

---

## 17. 关键风险与应对

### 风险 1：任务边界重叠导致合并冲突

应对：Planner 必须生成 `writePaths`；调度前做路径冲突检测；共享文件任务默认串行。

### 风险 2：Agent 生成不可执行的任务

应对：严格 JSON Schema；静态 DAG 校验；Planner 失败不得启动 Worker；允许人工编辑任务后重新运行。

### 风险 3：Worker 无限循环或成本失控

应对：`maxTurns`、超时、最大费用、重试上限和并发上限全部配置化。

### 风险 4：模型切换导致上下文丢失

应对：保存完整 Session；使用新模型重新创建 Agent；切换事件可追踪；失败时回滚到旧 Worker。

### 风险 5：代码和密钥泄露

应对：服务端 Model Gateway；密钥加密；日志脱敏；Worker 沙箱；客户端不持有完整 Key。

### 风险 6：客户端和服务端状态不一致

应对：事件持久化、事件 ID、版本号、断线快照、幂等消费。

### 风险 7：过早开发复杂功能

应对：第一版只完成一个项目、一个 Run、2—4 个 Worker、一个集成分支和一个 Windows 客户端闭环。

---

## 18. MVP 最终验收标准

以下条件全部满足，才算 MVP 完成：

- [ ] Windows EXE 可以安装并启动；
- [ ] 用户可以登录服务端；
- [ ] 用户可以创建项目并配置 Git 仓库；
- [ ] 用户可以输入自然语言需求；
- [ ] Planner 输出合法结构化 DAG；
- [ ] DAG 中至少有两个可并行任务；
- [ ] 系统能检测任务依赖和路径冲突；
- [ ] 系统能创建独立 Git worktree；
- [ ] 两个 Pi Worker 能同时执行；
- [ ] Worker 的日志、工具调用和状态能实时显示；
- [ ] Worker 能运行测试并上报结果；
- [ ] Worker 能提交 commit；
- [ ] 一个 Worker 失败不会错误终止无依赖 Worker；
- [ ] 用户可以暂停、继续、取消和重试任务；
- [ ] 用户可以查看每个 Worker 的 Diff；
- [ ] Integrator 能生成集成分支；
- [ ] 模型 Profile 可以由后台创建和修改；
- [ ] API Key 不返回到客户端；
- [ ] 新任务能使用新模型配置；
- [ ] 运行中任务可以在下一 Turn 切换模型或安全重建 Session；
- [ ] 客户端断线重连后可以恢复 Run 状态；
- [ ] 单元测试、集成测试和类型检查通过；
- [ ] README 包含开发、部署、客户端打包和安全说明。

---

## 19. 给 Codex 的实现要求

请将本企划书视为实现约束，而不是仅供参考的描述。

### 实现原则

1. 先检查仓库当前状态和已有文件，不要盲目覆盖；
2. 先创建实现计划，再分阶段开发；
3. 先建立 Contracts 和状态机，再开发 UI；
4. 对核心流程使用测试驱动：Planner Schema、DAG、Worktree、调度器、模型解析、事件幂等；
5. 不要用假数据冒充真实 Worker；
6. 不要用一个共享目录模拟并行开发；
7. 不要把 API Key 写入客户端或日志；
8. 不要把任务状态只放在内存中；
9. 每完成一个模块都运行对应测试；
10. 如果某个外部依赖或 Pi API 不确定，先检查实际版本和源码，不要猜接口；
11. 首先跑通本地最小闭环，再扩展到 Docker 和远程 Worker；
12. 如果完整实现超出当前仓库范围，先交付可运行的垂直切片，不要留下只有页面没有后端的空壳。

### 推荐 Codex 实现顺序

```text
1. 检查仓库和环境
2. 建立 Monorepo / 或适配现有仓库
3. 建立 contracts
4. 建立数据库 schema
5. 实现 Pi Worker 单任务闭环
6. 实现 Git worktree
7. 实现 Planner DAG
8. 实现并发调度器
9. 实现 WebSocket 事件
10. 实现 API
11. 实现 Electron 客户端
12. 实现模型后台配置
13. 实现集成分支和 Review
14. 打包 Windows EXE
15. 执行端到端验收
```

### 完成定义

不能只提交：

- 页面原型；
- 空 API；
- 假日志；
- 假任务状态；
- 不能启动的 Worker；
- 没有测试的调度器；
- 只有 README 的方案。

必须提供：

- 可启动的服务端；
- 可执行的 Pi Worker；
- 真实的任务状态变化；
- 真实的 Git worktree；
- 真实的事件推送；
- 可安装或可构建的 Windows 客户端；
- 运行结果和测试输出。

---

## 20. 参考项目

- Pi Agent / Pi AI：<https://github.com/earendil-works/pi>
- Reasonix：<https://github.com/esengine/DeepSeek-Reasonix>
- Reasonix Subagent Profiles：<https://github.com/esengine/DeepSeek-Reasonix/blob/main/docs/SUBAGENT_PROFILES.md>
- Reasonix ACP：<https://github.com/esengine/DeepSeek-Reasonix/blob/main/docs/ACP.md>
- Reasonix Desktop Electron 社区实现：<https://github.com/suply/reasonix-desktop>
- Emdash：<https://github.com/generalaction/emdash>
- OpenAI Symphony：<https://github.com/openai/symphony>
- Optio：<https://github.com/jonwiggins/optio>

---

## 21. 最终判断

本项目的核心不是“同时启动很多 Agent”，而是建立一条可靠的工程闭环：

```text
需求
 → 结构化拆解
 → 依赖分析
 → 隔离工作区
 → 并行执行
 → 测试验证
 → Diff 审查
 → 集成合并
 → 可追踪结果
```

客户端 EXE 是控制面，不是全部系统；Pi 是执行内核，不是完整产品；真正的产品价值来自 Orchestrator、任务协议、模型路由、代码隔离、失败恢复和团队协作体验。

第一阶段优先保证闭环真实可运行，再逐步扩展远程 Worker、多人协作、自动 Review、成本控制和多平台客户端。
