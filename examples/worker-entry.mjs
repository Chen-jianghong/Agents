#!/usr/bin/env node
/**
 * Multi-Agent Worker 进程入口（企划书 §10「Pi Worker 执行环境」）
 *
 * 独立进程运行一个完整的 Multi-Agent Runtime，通过 JSONL RPC（stdin/stdout）
 * 向宿主暴露 Control Plane 能力：Profile 查询、Agent 任务提交/取消/重试、
 * Run 提交/调度等。宿主用 ControlPlaneWorkerProcess 管理本进程生命周期。
 *
 * 环境变量：
 *   WORKER_TOKEN         必选，RPC 握手鉴权 token（与宿主配置一致）
 *   WORKER_WORKSPACE     工作区路径（默认 process.cwd()）
 *   WORKER_AGENT_DIR     Pi agent 目录（默认 <workspace>/.pi-worker）
 *   WORKER_FAUX=1        注册 faux provider 自检（不访问外部模型）
 *   WORKER_MODEL_PROFILE Planner 模型名（默认 coding-strong）
 *
 * 示例（宿主侧，见 worker-demo.mjs）：
 *   node examples/worker-demo.mjs
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createMultiAgentRuntimeAsync,
  FileAgentEventStore,
  FileAgentTaskStore,
  FileRunStore,
} from "../dist/src/index.js";

const token = process.env.WORKER_TOKEN;
if (!token) {
  console.error("WORKER_TOKEN is required");
  process.exit(1);
}

const workspace = process.env.WORKER_WORKSPACE ?? process.cwd();
mkdirSync(workspace, { recursive: true });
const agentDir = process.env.WORKER_AGENT_DIR ?? join(workspace, ".pi-worker");
mkdirSync(agentDir, { recursive: true });

const modelRuntime = await ModelRuntime.create({
  modelsPath: null,
  allowModelNetwork: false,
});
if (process.env.WORKER_FAUX === "1") {
  const faux = fauxProvider({
    provider: "worker-faux",
    models: [{ id: "faux-model", reasoning: false }],
  });
  modelRuntime.registerNativeProvider(faux.provider);
}

const aliases = process.env.WORKER_FAUX === "1"
  ? { "coding-strong": "worker-faux/faux-model", "coding-balanced": "worker-faux/faux-model" }
  : {};

const runtime = await createMultiAgentRuntimeAsync({
  modelRuntime,
  ...(Object.keys(aliases).length > 0 ? { modelAliases: aliases } : {}),
  eventStore: new FileAgentEventStore(join(agentDir, "events.jsonl")),
  taskStore: new FileAgentTaskStore(join(agentDir, "tasks.jsonl")),
  runStore: new FileRunStore(join(agentDir, "runs")),
  controlPlaneExecution: { cwd: workspace, agentDir },
  controlPlaneScheduler: { maxParallel: 2 },
});

const rpc = runtime.createControlPlaneWorkerRpcServer(process.stdin, process.stdout, {
  authorize: (incomingToken) => incomingToken === token,
});
rpc.start();

process.stdin.on("close", () => {
  void runtime.controlPlane.flush().finally(() => process.exit(0));
});
