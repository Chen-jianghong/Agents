#!/usr/bin/env node
/**
 * 真实 Provider 端到端验证脚本
 *
 * 跑通完整链路：自然语言需求 → Planner 生成 DAG → RunScheduler 并行调度
 * → Worker 执行 → 结果收集（token/cost 统计）。
 *
 * 用法：
 *   # 方式 A：用 E2E_* 环境变量指定（推荐）
 *   E2E_PROVIDER=deepseek E2E_API_KEY=sk-xxx node examples/e2e-real-provider.mjs \
 *     --goal "在 workspace 下创建一个 data/hello.txt，内容为 Hello Multi-Agent"
 *
 *   # 方式 B：直接用 Provider 约定的环境变量（DeepSeek 读 DEEPSEEK_API_KEY）
 *   DEEPSEEK_API_KEY=sk-xxx node examples/e2e-real-provider.mjs --provider deepseek --model deepseek-chat
 *
 *   # 自检模式（faux provider，不访问外部模型服务，验证脚本链路本身）
 *   node examples/e2e-real-provider.mjs --self-test
 *
 * 支持的内置 Provider（Pi 0.83）：
 *   deepseek    → DEEPSEEK_API_KEY    (deepseek-chat / deepseek-reasoner)
 *   openai      → OPENAI_API_KEY      (gpt-4o / gpt-4o-mini / ...)
 *   anthropic   → ANTHROPIC_API_KEY   (claude-sonnet-4-6 / claude-sonnet-4-5 / ...)
 *   moonshotai  → MOONSHOT_API_KEY    (Kimi)
 *   zai         → ZAI_API_KEY         (智谱 GLM)
 *   google      → GEMINI_API_KEY      (Gemini)
 *
 * 默认在 <cwd>/.e2e-workspace 下执行（自动 git init），不会污染主仓库。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createMultiAgentRuntime,
  FileAgentEventStore,
  FileAgentTaskStore,
} from "../dist/src/index.js";

const PROVIDERS = {
  deepseek: { env: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat" },
  openai: { env: "OPENAI_API_KEY", defaultModel: "gpt-4o-mini" },
  anthropic: { env: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-6" },
  moonshotai: { env: "MOONSHOT_API_KEY", defaultModel: "kimi-k2-0711-preview" },
  zai: { env: "ZAI_API_KEY", defaultModel: "glm-4.5-flash" },
  google: { env: "GEMINI_API_KEY", defaultModel: "gemini-2.5-flash" },
};

const DEFAULT_GOAL =
  "在 workspace 下创建 data/hello.txt 文件，内容为 Hello Multi-Agent，并创建 data/readme.txt 文件说明用途。";

function parseArgs(argv) {
  const args = { provider: "deepseek", model: undefined, goal: DEFAULT_GOAL, workspace: undefined, agentDir: undefined, maxParallel: 2, selfTest: false, apiKey: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i];
    switch (arg) {
      case "--provider": args.provider = value(); break;
      case "--model": args.model = value(); break;
      case "--goal": args.goal = value(); break;
      case "--workspace": args.workspace = value(); break;
      case "--agent-dir": args.agentDir = value(); break;
      case "--max-parallel": args.maxParallel = Number(value()); break;
      case "--api-key": args.apiKey = value(); break;
      case "--self-test": args.selfTest = true; break;
      case "-h": case "--help":
        printHelp();
        process.exit(0);
      default:
        console.error(`未知参数: ${arg}（--help 查看用法）`);
        process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`用法:
  node examples/e2e-real-provider.mjs [--provider deepseek] [--model deepseek-chat] [--goal "需求"]
        [--workspace 目录] [--max-parallel 2] [--api-key sk-xxx] [--self-test]

支持 provider: ${Object.keys(PROVIDERS).join(", ")}
每个 provider 也直接读取约定环境变量（如 DEEPSEEK_API_KEY）。`);
}

async function prepareWorkspace(workspace) {
  await mkdir(workspace, { recursive: true });
  if (!existsSync(join(workspace, ".git"))) {
    spawnSync("git", ["init", "-q"], { cwd: workspace, stdio: "ignore" });
  }
  const gitignore = join(workspace, ".gitignore");
  if (!existsSync(gitignore)) {
    await writeFile(gitignore, "node_modules/\n.pi/\n");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = resolve(args.workspace ?? join(process.cwd(), ".e2e-workspace"));
  const agentDir = resolve(args.agentDir ?? join(workspace, ".pi"));
  await prepareWorkspace(workspace);
  console.log(`工作区: ${workspace}`);

  // ---- 1. 配置模型运行时 ----
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
  });

  let providerId;
  let modelName;
  if (args.selfTest) {
    // 自检：faux provider 模拟 Planner → Worker 回复，不访问外部服务
    const faux = fauxProvider({
      provider: "faux-e2e",
      models: [{ id: "faux-model", reasoning: false }],
    });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(JSON.stringify({
        goal: "自检需求",
        tasks: [
          {
            id: "create-file",
            title: "创建一个文本文件",
            role: "backend",
            dependsOn: [],
            writePaths: ["data"],
            acceptanceCriteria: ["data/hello.txt 存在"],
            testCommands: ["test -f data/hello.txt"],
          },
        ],
      })),
      fauxAssistantMessage("任务完成：已创建 data/hello.txt。"),
    ]);
    providerId = "faux-e2e";
    modelName = "faux-model";
    console.log("[self-test] 使用 faux provider，不访问外部模型服务");
  } else {
    const provider = PROVIDERS[args.provider];
    if (!provider) {
      console.error(`不支持的 provider: ${args.provider}（可选: ${Object.keys(PROVIDERS).join(", ")}）`);
      process.exit(2);
    }
    const apiKey = args.apiKey ?? process.env[provider.env] ?? process.env.E2E_API_KEY;
    if (!apiKey) {
      console.error(`
[缺少 API Key] 未检测到 ${provider.env}（或 --api-key / E2E_API_KEY）。

请先配置密钥，例如（Windows PowerShell）:
  setx ${provider.env} "sk-你的密钥"

或直接运行时传入:
  E2E_API_KEY=sk-xxx node examples/e2e-real-provider.mjs --provider ${args.provider}

也可以先用自检模式验证脚本链路（不访问网络）:
  node examples/e2e-real-provider.mjs --self-test
`);
      process.exit(1);
    }
    for (const builtin of builtinProviders()) {
      modelRuntime.registerNativeProvider(builtin);
    }
    providerId = args.provider;
    modelName = args.model ?? provider.defaultModel;
    await modelRuntime.setRuntimeApiKey(providerId, apiKey);
    console.log(`[model] provider=${providerId} model=${modelName}`);
  }

  const aliases = {
    "coding-strong": `${providerId}/${modelName}`,
    "coding-balanced": `${providerId}/${modelName}`,
  };

  // ---- 2. 组装 Runtime（事件/任务持久化到 agentDir 同级） ----
  const eventStore = new FileAgentEventStore(join(agentDir, "events.jsonl"));
  const taskStore = new FileAgentTaskStore(join(agentDir, "tasks.jsonl"));
  const runtime = createMultiAgentRuntime({
    modelRuntime,
    modelAliases: aliases,
    eventStore,
    taskStore,
    controlPlaneExecution: { cwd: workspace, agentDir },
    controlPlaneScheduler: { maxParallel: args.maxParallel },
  });

  // ---- 3. 提交 Run ----
  console.log(`[run] 目标: ${args.goal}`);
  const created = await runtime.controlPlane.handle({
    version: "v1",
    requestId: "e2e-create",
    type: "create_run",
    goal: args.goal,
    workspace,
  });
  if (!created.ok) {
    console.error(`[run] 创建失败: ${created.error.code} ${created.error.message}`);
    process.exit(1);
  }
  const runId = created.data.runId;

  const unsubscribe = runtime.controlPlane.subscribe((event) => {
    console.log(`  [event] ${event.type} ${event.payload?.taskId ?? ""}`.trimEnd());
  });

  console.log(`[run] 启动 ${runId}（规划中...）`);
  const started = await runtime.controlPlane.handle({
    version: "v1",
    requestId: "e2e-start",
    type: "start_run",
    runId,
  });
  if (!started.ok) {
    console.error(`[run] 启动失败: ${started.error.code} ${started.error.message}`);
    process.exit(1);
  }

  // ---- 4. 等待终态 ----
  const result = await runtime.controlPlaneScheduler.waitForRun(runId);
  unsubscribe();

  // ---- 5. 汇总输出 ----
  console.log("\n========== 运行结果 ==========");
  console.log(`Run: ${result.runId}  状态: ${result.status}`);
  if (result.error) console.log(`错误: ${result.error.code} ${result.error.message}`);
  console.log("");
  let totalTokens = 0;
  let totalCostUsd = 0;
  for (const task of result.tasks) {
    const line = `  [${task.status}] ${task.taskId} (${task.role})`;
    console.log(line);
    if (task.error) console.log(`      error: ${task.error.code} ${task.error.message}`);
    const usage = task.result?.usage;
    if (usage) {
      console.log(`      usage: tokens=${usage.totalTokens ?? "?"} costUsd=${usage.costUsd ?? "?"}`);
      totalTokens += usage.totalTokens ?? 0;
      totalCostUsd += usage.costUsd ?? 0;
    }
  }
  console.log("");
  console.log(`汇总: ${result.tasks.length} 个任务, tokens=${totalTokens}, costUsd=${totalCostUsd.toFixed(6)}`);

  // 清理 agent 会话目录，保留工作区产物
  await rm(join(agentDir, "sessions"), { recursive: true, force: true });

  if (result.status !== "succeeded") {
    console.error("\n[结果] Run 未成功，详见上方输出。");
    process.exit(1);
  }
  console.log(`\n[结果] 端到端验证通过。工作区产物: ${workspace}`);
}

main().catch((error) => {
  console.error("端到端验证失败:", error);
  process.exit(1);
});
