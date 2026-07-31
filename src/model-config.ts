/**
 * Model configuration contracts and JSON file storage: Providers, Model
 * Profiles and Agent Role Bindings (multi-agent-development-project-plan.md
 * §8 "模型配置中心").
 *
 * Security boundary: an API key never enters these records. A Provider only
 * references a secret by name (`apiKeySecretRef`); the actual credential is
 * resolved by the host SecretStore at session creation time. Reads never
 * return plaintext keys.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "./contracts.js";

export type ProviderKind =
  | "openai-compatible"
  | "anthropic"
  | "gemini"
  | "local"
  | "faux";

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Optional base URL for compatible providers. */
  baseUrl?: string;
  /** Name of the secret in the host SecretStore; never the key itself. */
  apiKeySecretRef?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProfileConfig {
  /** Unique config id (uuid). */
  id: string;
  /** Stable alias used by Agent profiles and role bindings (e.g. coding-strong). */
  name: string;
  providerId: string;
  modelName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEffort?: ThinkingLevel;
  timeoutSeconds?: number;
  maxConcurrency?: number;
  retryLimit?: number;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRoleBinding {
  role: string;
  modelProfileId: string;
  fallbackModelProfileId?: string;
  priority: number;
  enabled: boolean;
}

export interface ModelConfigSnapshot {
  providers: ProviderConfig[];
  modelProfiles: ModelProfileConfig[];
  roleBindings: AgentRoleBinding[];
}

export class ModelConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigValidationError";
  }
}

export class ModelConfigPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigPersistenceError";
  }
}

/** Built-in role bindings matching the existing Agent profile defaults. */
export const DEFAULT_ROLE_BINDINGS: readonly AgentRoleBinding[] = [
  { role: "planner", modelProfileId: "coding-strong", priority: 100, enabled: true },
  { role: "backend", modelProfileId: "coding-balanced", priority: 100, enabled: true },
  { role: "frontend", modelProfileId: "coding-balanced", priority: 100, enabled: true },
  { role: "qa", modelProfileId: "coding-balanced", priority: 100, enabled: true },
  { role: "reviewer", modelProfileId: "coding-strong", priority: 100, enabled: true },
  { role: "researcher", modelProfileId: "coding-balanced", priority: 100, enabled: true },
  { role: "coder", modelProfileId: "coding-balanced", priority: 100, enabled: true },
  { role: "tester", modelProfileId: "coding-balanced", priority: 100, enabled: true },
  { role: "docs", modelProfileId: "coding-fast", priority: 100, enabled: true },
  { role: "devops", modelProfileId: "coding-strong", priority: 100, enabled: true },
];

export function validateProviderConfig(provider: ProviderConfig): void {
  if (!provider.id || !provider.id.trim()) {
    throw new ModelConfigValidationError("Provider id must not be empty");
  }
  if (!provider.name.trim()) {
    throw new ModelConfigValidationError(`Provider ${provider.id} must have a name`);
  }
  if (hasPlaintextKey(provider)) {
    throw new ModelConfigValidationError(
      `Provider ${provider.id} must not contain a plaintext apiKey; use apiKeySecretRef`,
    );
  }
}

export function validateModelProfileConfig(profile: ModelProfileConfig): void {
  if (!profile.id.trim()) {
    throw new ModelConfigValidationError("Model profile id must not be empty");
  }
  if (!profile.name.trim() || profile.name.includes("/")) {
    throw new ModelConfigValidationError(
      `Model profile ${profile.id} must have a valid alias name without "/"`,
    );
  }
  if (!profile.providerId.trim()) {
    throw new ModelConfigValidationError(`Model profile ${profile.name} must reference a provider`);
  }
  if (!profile.modelName.trim()) {
    throw new ModelConfigValidationError(`Model profile ${profile.name} must reference a model name`);
  }
  if (!Number.isSafeInteger(profile.version) || profile.version < 1) {
    throw new ModelConfigValidationError(`Model profile ${profile.name} must have a positive version`);
  }
}

export function validateRoleBinding(binding: AgentRoleBinding): void {
  if (!binding.role.trim()) {
    throw new ModelConfigValidationError("Role binding must have a role");
  }
  if (!binding.modelProfileId.trim()) {
    throw new ModelConfigValidationError(`Role binding ${binding.role} must reference a model profile`);
  }
  if (!Number.isSafeInteger(binding.priority) || binding.priority < 0) {
    throw new ModelConfigValidationError(`Role binding ${binding.role} must have a non-negative priority`);
  }
}

/**
 * JSON-file storage for model configuration. Layout:
 *   <root>/providers/<id>.json
 *   <root>/model-profiles/<name>.json
 *   <root>/role-bindings/<role>.json
 */
export class FileModelConfigStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async loadAll(): Promise<ModelConfigSnapshot> {
    const [providers, modelProfiles, roleBindings] = await Promise.all([
      this.readJsonDirectory<ProviderConfig>("providers", validateProviderConfig),
      this.readJsonDirectory<ModelProfileConfig>("model-profiles", validateModelProfileConfig),
      this.readJsonDirectory<AgentRoleBinding>("role-bindings", validateRoleBinding),
    ]);
    return { providers, modelProfiles, roleBindings };
  }

  async saveProvider(provider: ProviderConfig): Promise<ProviderConfig> {
    validateProviderConfig(provider);
    await this.writeRecord("providers", `${provider.id}.json`, provider);
    return structuredClone(provider);
  }

  async removeProvider(id: string): Promise<void> {
    await this.removeRecord("providers", `${id}.json`);
  }

  async saveModelProfile(profile: ModelProfileConfig): Promise<ModelProfileConfig> {
    validateModelProfileConfig(profile);
    const current = await this.readCurrent<ModelProfileConfig>(
      "model-profiles",
      `${profile.name}.json`,
      validateModelProfileConfig,
    );
    if (current && profile.version <= current.version) {
      throw new ModelConfigPersistenceError(
        `Model profile ${profile.name} must use a higher version than ${current.version}`,
      );
    }
    await this.writeRecord("model-profiles", `${profile.name}.json`, profile);
    return structuredClone(profile);
  }

  async removeModelProfile(name: string): Promise<void> {
    await this.removeRecord("model-profiles", `${name}.json`);
  }

  async saveRoleBinding(binding: AgentRoleBinding): Promise<AgentRoleBinding> {
    validateRoleBinding(binding);
    await this.writeRecord("role-bindings", `${binding.role}.json`, binding);
    return structuredClone(binding);
  }

  async removeRoleBinding(role: string): Promise<void> {
    await this.removeRecord("role-bindings", `${role}.json`);
  }

  private async writeRecord(subdirectory: string, fileName: string, value: unknown): Promise<void> {
    const directory = join(this.root, subdirectory);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, fileName),
      JSON.stringify(value, null, 2) + "\n",
      "utf8",
    );
  }

  private async removeRecord(subdirectory: string, fileName: string): Promise<void> {
    try {
      await rm(join(this.root, subdirectory, fileName));
    } catch (error) {
      if (isNotFound(error)) {
        throw new ModelConfigPersistenceError(`Model config record not found: ${subdirectory}/${fileName}`);
      }
      throw error;
    }
  }

  private async readJsonDirectory<T>(
    subdirectory: string,
    validate: (value: T) => void,
  ): Promise<T[]> {
    const directory = join(this.root, subdirectory);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const records: T[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = await this.readCurrent(subdirectory, entry.name, validate);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  private async readCurrent<T>(
    subdirectory: string,
    fileName: string,
    validate: (value: T) => void,
  ): Promise<T | undefined> {
    let raw: string;
    try {
      raw = await readFile(join(this.root, subdirectory, fileName), "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    try {
      const record = JSON.parse(raw) as T;
      validate(record);
      return record;
    } catch (error) {
      if (error instanceof ModelConfigValidationError) {
        throw new ModelConfigPersistenceError(
          `Invalid model config ${subdirectory}/${fileName}: ${error.message}`,
        );
      }
      throw new ModelConfigPersistenceError(
        `Invalid JSON model config ${subdirectory}/${fileName}: ${String(error)}`,
      );
    }
  }
}

const PLAINTEXT_KEY_FIELDS = new Set(["apiKey", "api_key", "apikey", "key", "token"]);

function hasPlaintextKey(provider: ProviderConfig): boolean {
  const record = provider as unknown as Record<string, unknown>;
  return [...PLAINTEXT_KEY_FIELDS].some((field) => {
    const value = record[field];
    return typeof value === "string" && value.length > 0;
  });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
