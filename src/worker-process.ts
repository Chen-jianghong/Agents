import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentEvent } from "./contracts.js";
import {
  ControlPlaneWorkerRpcClient,
  type ControlPlaneWorkerRpcClientOptions,
} from "./control-plane-worker-rpc.js";
import type { ControlPlaneRequest, ControlPlaneResponse } from "./control-plane.js";

export interface ControlPlaneWorkerProcessOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  token?: string;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export class WorkerProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerProcessError";
  }
}

/**
 * Host-side lifecycle wrapper for an independent Pi Worker process. The
 * worker is expected to expose ControlPlaneWorkerRpcServer on stdin/stdout.
 */
export class ControlPlaneWorkerProcess {
  private readonly options: Required<
    Pick<ControlPlaneWorkerProcessOptions, "startupTimeoutMs" | "shutdownTimeoutMs">
  > & ControlPlaneWorkerProcessOptions;
  private child: ChildProcessWithoutNullStreams | undefined;
  private client: ControlPlaneWorkerRpcClient | undefined;
  private lifecycle: Promise<void> | undefined;
  private stopping = false;
  private readonly eventListeners = new Set<(event: AgentEvent) => void>();

  constructor(options: ControlPlaneWorkerProcessOptions) {
    const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    assertPositiveInteger(startupTimeoutMs, "startupTimeoutMs");
    assertPositiveInteger(shutdownTimeoutMs, "shutdownTimeoutMs");
    if (options.command.trim().length === 0) throw new WorkerProcessError("Worker command is required");
    this.options = {
      ...options,
      startupTimeoutMs,
      shutdownTimeoutMs,
    };
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.lifecycle) return this.lifecycle;
    if (this.child) throw new WorkerProcessError("Worker process is already started");
    this.lifecycle = this.startInternal();
    try {
      await this.lifecycle;
    } catch (error) {
      this.lifecycle = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    const client = this.client;
    if (!child) return;
    this.stopping = true;
    try {
      await client?.stop();
    } finally {
      await this.waitForExit(child, false);
      this.child = undefined;
      this.client = undefined;
      this.lifecycle = undefined;
      this.stopping = false;
    }
  }

  async request(request: ControlPlaneRequest): Promise<ControlPlaneResponse> {
    if (!this.client || !this.running) throw new WorkerProcessError("Worker process is not running");
    return this.client.request(request);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    const unsubscribeClient = this.client?.subscribe(listener);
    return () => {
      this.eventListeners.delete(listener);
      unsubscribeClient?.();
    };
  }

  private async startInternal(): Promise<void> {
    const child = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stopping = false;
    child.stderr.resume();

    const clientOptions: ControlPlaneWorkerRpcClientOptions = {
      ...(this.options.token !== undefined ? { token: this.options.token } : {}),
      ...(this.options.maxFrameBytes !== undefined ? { maxFrameBytes: this.options.maxFrameBytes } : {}),
      ...(this.options.maxBufferedBytes !== undefined ? { maxBufferedBytes: this.options.maxBufferedBytes } : {}),
    };
    const client = new ControlPlaneWorkerRpcClient(child.stdout, child.stdin, clientOptions);
    this.client = client;
    for (const listener of this.eventListeners) client.subscribe(listener);

    const onSpawnError = (error: Error) => {
      if (!child.stdout.destroyed) child.stdout.destroy(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.stopping || child.stdout.destroyed) return;
      child.stdout.destroy(new WorkerProcessError(
        `Worker process exited before shutdown (code=${code ?? "none"}, signal=${signal ?? "none"})`,
      ));
    };
    child.once("error", onSpawnError);
    child.once("exit", onExit);

    try {
      await withTimeout(
        client.start(),
        this.options.startupTimeoutMs,
        `Worker process did not complete RPC handshake within ${this.options.startupTimeoutMs}ms`,
      );
    } catch (error) {
      await this.stopAfterFailedStart(child);
      if (error instanceof WorkerProcessError) throw error;
      throw new WorkerProcessError(error instanceof Error ? error.message : String(error));
    } finally {
      child.off("error", onSpawnError);
      child.off("exit", onExit);
    }
  }

  private async stopAfterFailedStart(child: ChildProcessWithoutNullStreams): Promise<void> {
    this.stopping = true;
    try {
      await this.client?.stop();
    } finally {
      await this.waitForExit(child, true);
      this.child = undefined;
      this.client = undefined;
      this.stopping = false;
    }
  }

  private async waitForExit(child: ChildProcessWithoutNullStreams, forceOnTimeout: boolean): Promise<void> {
    if (child.exitCode !== null) return;
    const exited = await Promise.race([
      waitForChildExit(child),
      delay(this.options.shutdownTimeoutMs),
    ]);
    if (exited || child.exitCode !== null) return;
    if (forceOnTimeout || !child.killed) child.kill("SIGTERM");
    const terminated = await Promise.race([
      waitForChildExit(child),
      delay(this.options.shutdownTimeoutMs),
    ]);
    if (!terminated && child.exitCode === null) child.kill("SIGKILL");
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkerProcessError(`${name} must be a positive safe integer`);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WorkerProcessError(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => child.once("exit", () => resolve(true)));
}

function delay(milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => setTimeout(() => resolve(false), milliseconds));
}
