import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentProfile, AgentResult, AgentTask } from "./contracts.js";
import { redactSensitiveValue } from "./event-store.js";

export type AgentTaskRecordStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/**
 * The serializable part of AgentRunOptions. Pi runtime objects, models and
 * workspace providers are intentionally resolved again by the host on retry.
 */
export interface AgentTaskExecutionSnapshot {
  cwd: string;
  agentDir: string;
  parentAgentId?: string;
  maxConcurrentChildren?: number;
  /** True when retrying without a host workspace provider would be unsafe. */
  workspaceProviderRequired?: boolean;
}

export interface AgentTaskRecord {
  task: AgentTask;
  profileId: string;
  profileVersion: number;
  /** Profile bound to the task at submission time. Optional for old records. */
  profileSnapshot?: AgentProfile;
  /** Safe execution paths and parent limits from the original submission. */
  executionSnapshot?: AgentTaskExecutionSnapshot;
  status: AgentTaskRecordStatus;
  attempt: number;
  sessionId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: AgentResult;
}

export interface AgentTaskFilter {
  profileId?: string;
  status?: AgentTaskRecordStatus;
  runId?: string;
  parentTaskId?: string;
}

export interface AgentTaskStore {
  upsert(record: AgentTaskRecord): Promise<void>;
  get(agentTaskId: string): Promise<AgentTaskRecord | undefined>;
  list(filter?: AgentTaskFilter): Promise<AgentTaskRecord[]>;
}

export class AgentTaskPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTaskPersistenceError";
  }
}

/**
 * JSON snapshot storage for task recovery. Writes are serialized and replaced
 * atomically so a process crash cannot leave a partially written task index.
 */
export class FileAgentTaskStore implements AgentTaskStore {
  private readonly filePath: string;
  private readonly tempPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
    this.tempPath = `${this.filePath}.tmp`;
  }

  upsert(record: AgentTaskRecord): Promise<void> {
    const sanitized = redactSensitiveValue(record) as AgentTaskRecord;
    this.writeQueue = this.writeQueue.then(async () => {
      const records = await this.readRecords();
      records[record.task.id] = sanitized;
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.tempPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
      await rename(this.tempPath, this.filePath);
    }).catch((error) => {
      if (error instanceof AgentTaskPersistenceError) throw error;
      throw new AgentTaskPersistenceError("Unable to persist Agent task records");
    });
    return this.writeQueue;
  }

  async get(agentTaskId: string): Promise<AgentTaskRecord | undefined> {
    await this.writeQueue;
    const record = (await this.readRecords())[agentTaskId];
    return record ? structuredClone(record) : undefined;
  }

  async list(filter: AgentTaskFilter = {}): Promise<AgentTaskRecord[]> {
    await this.writeQueue;
    const records = Object.values(await this.readRecords());
    return records
      .filter((record) =>
        (filter.profileId === undefined || record.profileId === filter.profileId)
        && (filter.status === undefined || record.status === filter.status)
        && (filter.runId === undefined || record.task.runId === filter.runId)
        && (filter.parentTaskId === undefined || record.task.taskId === filter.parentTaskId),
      )
      .map((record) => structuredClone(record));
  }

  private async readRecords(): Promise<Record<string, AgentTaskRecord>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return {};
      throw new AgentTaskPersistenceError("Unable to read Agent task records");
    }
    try {
      const records = JSON.parse(raw) as Record<string, AgentTaskRecord>;
      if (typeof records !== "object" || records === null || Array.isArray(records)) {
        throw new Error("task index must be an object");
      }
      return records;
    } catch {
      throw new AgentTaskPersistenceError("Agent task store contains invalid JSON");
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
