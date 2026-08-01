/**
 * Multi-Agent Dev 桌面应用 - Electron 主进程
 *
 * 启动内置 Multi-Agent Runtime + 回环 REST server，创建桌面窗口。
 * 渲染进程通过 preload 暴露的 apiBaseUrl 访问 REST API（供应商管理、
 * 模型配置、Run 调度等），不直接接触 Node/Pi 对象。
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { join, resolve, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createMultiAgentRuntimeAsync,
  FileModelConfigStore,
  FileRunStore,
  FileUserStore,
  AuthService,
  type MultiAgentRuntime,
} from "../../../dist/src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;

/** 本地 JSON 文件 SecretStore（桌面版凭据存储）。 */
function fileSecrets(filePath: string) {
  return {
    async get(ref: string) {
      if (!existsSync(filePath)) return undefined;
      const all = JSON.parse(readFileSync(filePath, "utf8"));
      return all[ref];
    },
    async set(ref: string, value: string) {
      const all = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : {};
      all[ref] = value;
      writeFileSync(filePath, JSON.stringify(all, null, 2), "utf8");
    },
    async delete(ref: string) {
      if (!existsSync(filePath)) return;
      const all = JSON.parse(readFileSync(filePath, "utf8"));
      delete all[ref];
      writeFileSync(filePath, JSON.stringify(all, null, 2), "utf8");
    },
  };
}

let mainWindow: BrowserWindow | null = null;
let restPort = 0;
let runtime: MultiAgentRuntime | undefined;
let server: ReturnType<MultiAgentRuntime["createRestApiServer"]> | undefined;

async function startBackend(): Promise<void> {
  const dataDir = resolve(app.getPath("userData"), "data");
  mkdirSync(dataDir, { recursive: true });
  const workspace = process.cwd();

  // 本地认证：users.json 持久化，默认 admin 账号（初始密码 admin）。
  const userStore = new FileUserStore(join(dataDir, "users"));
  await userStore.seedAdmin({ username: "admin", password: "admin" });
  const auth = new AuthService(userStore);

  runtime = await createMultiAgentRuntimeAsync({
    modelConfigStore: new FileModelConfigStore(join(dataDir, "models")),
    secrets: fileSecrets(join(dataDir, "secrets.json")),
    runStore: new FileRunStore(join(dataDir, "runs")),
    controlPlaneExecution: { cwd: workspace, agentDir: join(dataDir, "pi") },
    controlPlaneScheduler: { maxParallel: 2 },
    auth,
  });

  server = runtime.createRestApiServer({
    host: "127.0.0.1",
    port: 0,
    auth,
    authorize: auth.authorize,
  });
  const address = await server.start();
  restPort = address.port;
  console.log(`[desktop] REST API bound to http://127.0.0.1:${restPort}`);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Multi-Agent Dev",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const rendererEntry = join(__dirname, "..", "dist-renderer", "index.html");
  void mainWindow.loadFile(rendererEntry);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await startBackend();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("desktop:get-api-base", () => `http://127.0.0.1:${restPort}`);

app.on("before-quit", () => {
  if (server) {
    void server.stop();
  }
});
