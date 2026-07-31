#!/usr/bin/env node
/**
 * Multi-Agent Dev 开发服务器（开箱即用）
 *
 * 启动 REST API + 供应商添加表单 + 模型配置中心 + Control Plane：
 *   - GET  /ui/vendors           浏览器供应商添加表单
 *   - POST /api/model/vendors    一键添加供应商
 *   - GET  /api/model/*          模型配置中心查询
 *   - POST /api/runs ...         Run 管理（需要配置模型后可用）
 *
 * 用法：
 *   node examples/dev-server.mjs [--port 8787] [--data .multi-agent-dev]
 *
 * 密钥配置：表单里填的 API Key 会存入 <data>/secrets.json（本地文件
 * SecretStore，演示用；生产环境请换成宿主 SecretStore）。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createMultiAgentRuntimeAsync, FileModelConfigStore, FileRunStore } from "../dist/src/index.js";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] ?? 8787);
const dataDir = resolve(args[args.indexOf("--data") + 1] ?? ".multi-agent-dev");
mkdirSync(dataDir, { recursive: true });

/** 本地 JSON 文件 SecretStore（演示用；生产请替换为宿主 SecretStore）。 */
const secretsFile = join(dataDir, "secrets.json");
const fileSecrets = {
  async get(ref) {
    if (!existsSync(secretsFile)) return undefined;
    const all = JSON.parse(readFileSync(secretsFile, "utf8"));
    return all[ref];
  },
  async set(ref, value) {
    const all = existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, "utf8")) : {};
    all[ref] = value;
    writeFileSync(secretsFile, JSON.stringify(all, null, 2), "utf8");
  },
  async delete(ref) {
    if (!existsSync(secretsFile)) return;
    const all = JSON.parse(readFileSync(secretsFile, "utf8"));
    delete all[ref];
    writeFileSync(secretsFile, JSON.stringify(all, null, 2), "utf8");
  },
};

const workspace = process.cwd();
const runtime = await createMultiAgentRuntimeAsync({
  modelConfigStore: new FileModelConfigStore(join(dataDir, "models")),
  secrets: fileSecrets,
  runStore: new FileRunStore(join(dataDir, "runs")),
  controlPlaneExecution: { cwd: workspace, agentDir: join(dataDir, "pi") },
  controlPlaneScheduler: { maxParallel: 2 },
});

const server = runtime.createRestApiServer({ port });
const address = await server.start();
console.log("");
console.log("==============================================");
console.log("  Multi-Agent Dev 开发服务器已启动");
console.log(`  供应商添加表单: http://127.0.0.1:${address.port}/ui/vendors`);
console.log(`  健康检查:       http://127.0.0.1:${address.port}/api/health`);
console.log(`  数据目录:       ${dataDir}`);
console.log("==============================================");
console.log("");
console.log("  1) 浏览器打开上面的表单页，填写供应商名称/API 地址/API Key/模型名称/上下文");
console.log("  2) 添加成功后，可在 GET /api/model/providers 看到配置");
console.log("  3) API Key 只写入 <data>/secrets.json，不会出现在 Provider 配置中");
console.log("");

process.on("SIGINT", () => {
  void server.stop().finally(() => process.exit(0));
});
