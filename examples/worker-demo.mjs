#!/usr/bin/env node
/**
 * 宿主侧 Worker 进程演示：启动独立 Worker，通过 JSONL RPC 提交 Agent 任务。
 *
 * 默认自检模式（WORKER_FAUX=1，不访问外部模型）：
 *   node examples/worker-demo.mjs
 *
 * 真实模式（需要先配置模型 API Key，如 DEEPSEEK_API_KEY）：
 *   WORKER_TOKEN=dev-token WORKER_WORKSPACE=<目录> node examples/worker-demo.mjs --real
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createMultiAgentRuntime } from "../dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "worker-entry.mjs");
const real = process.argv.includes("--real");
const workspace = process.env.WORKER_WORKSPACE
  ?? join(process.cwd(), ".e2e-workspace");

const runtime = createMultiAgentRuntime();
const worker = runtime.createControlPlaneWorkerProcess({
  command: process.execPath,
  args: [entry],
  env: {
    WORKER_TOKEN: "dev-token",
    WORKER_WORKSPACE: workspace,
    ...(real ? {} : { WORKER_FAUX: "1" }),
    PATH: process.env.PATH,
  },
  token: "dev-token",
  startupTimeoutMs: 10_000,
  shutdownTimeoutMs: 5_000,
});

try {
  await worker.start();
  console.log(`[host] worker started (pid=${worker.pid})`);

  const profiles = await worker.request({
    version: "v1",
    requestId: "demo-profiles",
    type: "list_profiles",
  });
  const profileNames = profiles.ok
    ? profiles.data.map((p) => p.name).join(", ")
    : `error ${profiles.error?.code}`;
  console.log(`[host] profiles: ${profileNames}`);

  const submitted = await worker.request({
    version: "v1",
    requestId: "demo-run",
    type: "run_agent",
    profileId: "researcher",
    task: {
      id: "worker-demo-task",
      workspace,
      task: "Return a focused report on the workspace",
      acceptanceCriteria: ["Return evidence"],
      depth: 0,
    },
  });
  console.log(
    `[host] run_agent: ${submitted.ok ? JSON.stringify(submitted.data) : `error ${submitted.error?.code} ${submitted.error?.message}`}`,
  );
  if (!submitted.ok) process.exitCode = 1;

  const result = await worker.request({
    version: "v1",
    requestId: "demo-result",
    type: "get_result",
    agentTaskId: submitted.data.agentTaskId,
  });
  console.log(`[host] result: ${result.ok ? JSON.stringify(result.data) : `error ${result.error?.code}`}`);
} finally {
  await worker.stop();
  console.log("[host] worker stopped");
}
