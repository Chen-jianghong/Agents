/** 渲染进程的 REST API 客户端（通过 preload 获取地址）。 */

interface DesktopBridge {
  apiBaseUrl: () => Promise<string>;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

let cachedBase: string | undefined;

export async function apiBase(): Promise<string> {
  if (!cachedBase) {
    if (window.desktop) {
      cachedBase = await window.desktop.apiBaseUrl();
    } else {
      // 浏览器开发模式：直接连默认端口。
      cachedBase = "http://127.0.0.1:8787";
    }
  }
  return cachedBase;
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; data: T }> {
  const base = await apiBase();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, data: body as T };
}

export interface Vendor {
  provider: {
    id: string;
    name: string;
    kind: string;
    baseUrl?: string;
    apiKeySecretRef?: string;
    enabled: boolean;
  };
  modelProfile: {
    name: string;
    providerId: string;
    modelName: string;
    contextWindow?: number;
  };
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind: string;
  baseUrl?: string;
  apiKeySecretRef?: string;
  enabled: boolean;
}

export interface ModelProfileConfig {
  name: string;
  providerId: string;
  modelName: string;
  contextWindow?: number;
  enabled: boolean;
  version: number;
}

export function addVendor(input: {
  name: string;
  baseUrl?: string;
  apiKey?: string;
  modelName: string;
  contextWindow?: number;
}): Promise<{ status: number; data: Vendor | { error: { message: string } } }> {
  return apiFetch<Vendor>("/api/model/vendors", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listProviders(): Promise<{ status: number; data: ProviderConfig[] }> {
  return apiFetch<ProviderConfig[]>("/api/model/providers");
}

export function removeProvider(id: string): Promise<{ status: number; data: unknown }> {
  return apiFetch(`/api/model/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listModelProfiles(): Promise<{ status: number; data: ModelProfileConfig[] }> {
  return apiFetch<ModelProfileConfig[]>("/api/model/profiles");
}

// ---- Run 调度 ----

export interface PlanTask {
  id: string;
  title: string;
  role: string;
  dependsOn: string[];
  modelProfile?: string;
  writePaths: string[];
  acceptanceCriteria: string[];
  testCommands: string[];
}

export interface RunTaskSnapshot {
  taskId: string;
  title: string;
  role: string;
  status: string;
  dependsOn: string[];
  writePaths: string[];
  modelProfile?: string;
  agentTaskId?: string;
  profileId?: string;
  error?: { code: string; message: string };
  result?: unknown;
}

export interface RunSnapshot {
  runId: string;
  status: string;
  goal: string;
  workspace: string;
  maxParallel: number;
  paused?: boolean;
  dag?: { goal: string; tasks: PlanTask[] };
  tasks: RunTaskSnapshot[];
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}

export interface AgentEvent {
  eventId: string;
  agentId: string;
  agentTaskId?: string;
  type: string;
  timestamp: string;
  payload: unknown;
}

export function createRun(input: { goal: string; maxParallel?: number }): Promise<{ status: number; data: RunSnapshot | { error: { message: string } } }> {
  return apiFetch<RunSnapshot>("/api/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function startRun(runId: string): Promise<{ status: number; data: RunSnapshot | { error: { message: string } } }> {
  return apiFetch<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}/start`, { method: "POST" });
}

export function cancelRun(runId: string): Promise<{ status: number; data: unknown }> {
  return apiFetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

export function pauseRun(runId: string): Promise<{ status: number; data: RunSnapshot }> {
  return apiFetch<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}/pause`, { method: "POST" });
}

export function resumeRun(runId: string): Promise<{ status: number; data: RunSnapshot }> {
  return apiFetch<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" });
}

export function retryRun(runId: string): Promise<{ status: number; data: RunSnapshot }> {
  return apiFetch<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}/retry`, { method: "POST" });
}

export interface IntegrationReport {
  runId: string;
  status: string;
  branch?: string;
  baseCommit?: string;
  appliedTasks: string[];
  conflicts: Array<{ taskId: string; detail: string }>;
  message: string;
}

export function integrateRun(runId: string): Promise<{ status: number; data: IntegrationReport | { error: { message: string } } }> {
  return apiFetch<IntegrationReport>(`/api/runs/${encodeURIComponent(runId)}/integrate`, { method: "POST" });
}

export function listRuns(): Promise<{ status: number; data: RunSnapshot[] }> {
  return apiFetch<RunSnapshot[]>("/api/runs");
}

export function getRun(runId: string): Promise<{ status: number; data: RunSnapshot | { error: { message: string } } }> {
  return apiFetch<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}`);
}

export function listRunHistory(runId: string): Promise<{ status: number; data: AgentEvent[] }> {
  return apiFetch<AgentEvent[]>(`/api/runs/${encodeURIComponent(runId)}/events/history`);
}

/** 订阅 Run 实时事件（SSE）。返回关闭函数。 */
export function openRunEvents(runId: string, onEvent: (event: AgentEvent) => void): () => void {
  let source: EventSource | undefined;
  void apiBase().then((base) => {
    source = new EventSource(`${base}/api/runs/${encodeURIComponent(runId)}/events`);
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as AgentEvent);
      } catch {
        // 忽略非 JSON 帧
      }
    };
  });
  return () => source?.close();
}
