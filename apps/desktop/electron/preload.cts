/**
 * Preload：通过 contextBridge 只暴露渲染进程需要的白名单能力。
 * 渲染进程不接触 Node API，只拿到 REST API 地址。
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  apiBaseUrl: () => ipcRenderer.invoke("desktop:get-api-base") as Promise<string>,
});
