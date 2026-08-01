/** 渲染进程的 REST API 客户端（通过 preload 获取地址）。 */

interface DesktopBridge {
  apiBaseUrl: () => Promise<string>;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

const TOKEN_KEY = "multi-agent-dev-token";

export function authToken(): string | undefined {
  return localStorage.getItem(TOKEN_KEY) ?? undefined;
}

export function setAuthToken(token: string | undefined): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
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
  const token = authToken();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
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

// ---- 认证 ----

export interface PublicUser {
  id: string;
  username: string;
  role: string;
  createdAt: string;
}

export async function login(username: string, password: string): Promise<{ status: number; data: { token: string; user: PublicUser } | { error: { message: string } } }> {
  const result = await apiFetch<{ token: string; user: PublicUser }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (result.status === 200) {
    const { token } = result.data as { token: string };
    setAuthToken(token);
  }
  return result;
}

export async function logout(): Promise<void> {
  const token = authToken();
  if (token) {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // 忽略登出请求失败，本地 token 照常清除。
    }
  }
  setAuthToken(undefined);
}

export async function me(): Promise<PublicUser | undefined> {
  if (!authToken()) return undefined;
  const result = await apiFetch<PublicUser>("/api/auth/me");
  return result.status === 200 ? (result.data as PublicUser) : undefined;
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

export interface MergeReport {
  runId: string;
  status: string;
  branch?: string;
  message: string;
}

export function mergeRun(runId: string): Promise<{ status: number; data: MergeReport | { error: { message: string } } }> {
  return apiFetch<MergeReport>(`/api/runs/${encodeURIComponent(runId)}/merge`, { method: "POST" });
}

export interface ReviewReport {
  findings: string[];
  evidence: string[];
  recommendations: string[];
  risks: string[];
}

export type ReviewOutcome =
  | { status: "reviewed"; report: ReviewReport }
  | { status: "review_failed"; reason: { code: string; message: string }; rawOutput?: string };

export function reviewRun(runId: string): Promise<{ status: number; data: ReviewOutcome | { error: { message: string } } }> {
  return apiFetch<ReviewOutcome>(`/api/runs/${encodeURIComponent(runId)}/review`, { method: "POST" });
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
