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
