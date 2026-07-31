import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentEvent } from "./contracts.js";

export interface AgentEventFilter {
  agentId?: string;
  agentTaskId?: string;
  type?: string;
}

export interface AgentEventStore {
  append(event: AgentEvent): Promise<void>;
  list(filter?: AgentEventFilter): Promise<AgentEvent[]>;
}

export class AgentEventPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentEventPersistenceError";
  }
}

/**
 * Append-only JSONL storage for normalized Agent events. The store serializes
 * writes so concurrent child Agents cannot interleave JSON records.
 */
export class FileAgentEventStore implements AgentEventStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  append(event: AgentEvent): Promise<void> {
    const line = serializeEvent(event);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${line}\n`, "utf8");
    });
    return this.writeQueue;
  }

  async list(filter: AgentEventFilter = {}): Promise<AgentEvent[]> {
    await this.writeQueue;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw new AgentEventPersistenceError(`Unable to read event store: ${this.filePath}`);
    }

    const events = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseEventLine);
    return events.filter((event) =>
      (filter.agentId === undefined || event.agentId === filter.agentId)
      && (filter.agentTaskId === undefined || event.agentTaskId === filter.agentTaskId)
      && (filter.type === undefined || event.type === filter.type),
    ).map((event) => structuredClone(event));
  }
}

const SENSITIVE_KEY = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/i;
const USAGE_METRIC_KEY = /^(?:input|output|cacheRead|cacheWrite|total)Tokens$/;

function serializeEvent(event: AgentEvent): string {
  try {
    return JSON.stringify(redactSensitiveValue(event));
  } catch {
    throw new AgentEventPersistenceError(`Unable to serialize event ${event.eventId}`);
  }
}

function parseEventLine(line: string): AgentEvent {
  try {
    const event = JSON.parse(line) as Partial<AgentEvent>;
    if (typeof event.eventId !== "string" || typeof event.agentId !== "string" || typeof event.type !== "string") {
      throw new Error("missing event identity");
    }
    return event as AgentEvent;
  } catch {
    throw new AgentEventPersistenceError("Event store contains an invalid JSONL record");
  }
}

export function redactSensitiveValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key) && !USAGE_METRIC_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item));
  if (typeof value === "bigint") return "[BIGINT]";
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSensitiveValue(entryValue, entryKey)]),
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
