/**
 * Run snapshot persistence (project plan §7 "任务状态不只在内存").
 *
 * RunScheduler keeps live state in memory; FileRunStore mirrors every
 * transition to disk so a restarted host can reload terminal Runs and
 * mark interrupted ones as failed instead of losing them entirely.
 * Task-level recovery stays in FileAgentTaskStore + retry_agent.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunSnapshot } from "./plan-contracts.js";

export interface RunStore {
  save(run: RunSnapshot): Promise<void>;
  list(): Promise<RunSnapshot[]>;
  remove(runId: string): Promise<void>;
}

export class RunStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStoreError";
  }
}

export class FileRunStore implements RunStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async save(run: RunSnapshot): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true });
      const filePath = join(this.root, `${sanitizeRunId(run.runId)}.json`);
      await writeFile(filePath, JSON.stringify(run, null, 2), "utf8");
    } catch (error) {
      throw new RunStoreError(
        `Unable to persist Run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async list(): Promise<RunSnapshot[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      // Missing directory means no persisted Runs yet.
      return [];
    }
    const runs: RunSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(this.root, entry), "utf8");
        runs.push(JSON.parse(raw) as RunSnapshot);
      } catch {
        // Skip corrupt records; never let one bad file break the store.
        continue;
      }
    }
    return runs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async remove(runId: string): Promise<void> {
    try {
      await rm(join(this.root, `${sanitizeRunId(runId)}.json`), { force: true });
    } catch (error) {
      throw new RunStoreError(
        `Unable to remove Run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function sanitizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_-]/g, "_");
}
