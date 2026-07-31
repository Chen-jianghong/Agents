/**
 * ModelConfigService: host-facing CRUD for Providers / Model Profiles /
 * Role Bindings, plus the resolution surface used by ModelGateway:
 *
 * - buildAliases()         -> ModelAliases for a fresh ModelGateway
 * - credentialResolver()   -> CredentialResolver that reads secret refs
 * - resolveRoleModel()     -> role -> enabled ModelProfile (+fallback)
 *
 * Secrets never live here: a Provider stores only `apiKeySecretRef` and the
 * host SecretStore returns the actual credential at session-creation time.
 */
import { randomUUID } from "node:crypto";
import type { CredentialResolver } from "./model-gateway.js";
import type { ModelAliases } from "./model-runtime.js";
import {
  DEFAULT_ROLE_BINDINGS,
  FileModelConfigStore,
  ModelConfigValidationError,
  validateModelProfileConfig,
  validateProviderConfig,
  validateRoleBinding,
  type AgentRoleBinding,
  type ModelConfigSnapshot,
  type ModelProfileConfig,
  type ProviderConfig,
  type ProviderKind,
} from "./model-config.js";

/** Host-owned secret vault. Plaintext keys only cross this interface. */
export interface SecretStore {
  get(secretRef: string): Promise<string | undefined>;
  set(secretRef: string, value: string): Promise<void>;
  delete(secretRef: string): Promise<void>;
}

export type ProviderInput = Omit<ProviderConfig, "createdAt" | "updatedAt">;

export type ModelProfileInput = Omit<
  ModelProfileConfig,
  "id" | "version" | "createdAt" | "updatedAt"
>;

/** One-form vendor registration (provider + default model profile). */
export interface VendorInput {
  /** Vendor display name; provider id is derived from it. */
  name: string;
  /** API base URL (e.g. https://api.deepseek.com). */
  baseUrl?: string;
  /** Plaintext key persisted into the host SecretStore. */
  apiKey?: string;
  /** Alternative: reference an existing secret by name. */
  apiKeySecretRef?: string;
  kind?: ProviderKind;
  /** Model name exposed by the vendor (e.g. deepseek-chat). */
  modelName: string;
  /** Model context window in tokens. */
  contextWindow?: number;
  /** Model profile name; defaults to `<providerId>-default`. */
  modelProfileName?: string;
}

export interface VendorResult {
  provider: ProviderConfig;
  modelProfile: ModelProfileConfig;
}

export interface ResolvedRoleModel {
  modelProfile: ModelProfileConfig;
  fallback?: ModelProfileConfig;
  binding: AgentRoleBinding;
}

export interface ModelConfigServiceOptions {
  store: FileModelConfigStore;
  secrets?: SecretStore;
  now?: () => string;
  /** Seed profiles used when the store is empty. */
  defaultModelProfiles?: ModelProfileConfig[];
}

export class ModelConfigService {
  private readonly store: FileModelConfigStore;
  private readonly secrets: SecretStore | undefined;
  private readonly now: () => string;
  private readonly defaultModelProfiles: ModelProfileConfig[];

  private providers: Map<string, ProviderConfig> = new Map();
  private modelProfiles: Map<string, ModelProfileConfig> = new Map();
  private roleBindings: Map<string, AgentRoleBinding> = new Map();

  constructor(options: ModelConfigServiceOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.now = options.now ?? (() => new Date().toISOString());
    this.defaultModelProfiles = [...(options.defaultModelProfiles ?? [])];
    for (const binding of DEFAULT_ROLE_BINDINGS) {
      this.roleBindings.set(binding.role, { ...binding });
    }
  }

  /** Load persisted config; seeds default role bindings when absent. */
  async load(): Promise<ModelConfigSnapshot> {
    const snapshot = await this.store.loadAll();
    this.providers = new Map(snapshot.providers.map((provider) => [provider.id, provider]));
    this.modelProfiles = new Map(
      snapshot.modelProfiles.map((profile) => [profile.name, profile]),
    );
    // Persisted bindings override the built-in defaults by role.
    this.roleBindings = new Map(DEFAULT_ROLE_BINDINGS.map((binding) => [binding.role, { ...binding }]));
    for (const binding of snapshot.roleBindings) {
      this.roleBindings.set(binding.role, binding);
    }
    // Seed default profiles that the store does not persist yet.
    this.seedModelProfiles();
    return this.snapshot();
  }

  // ---- Providers ----

  listProviders(): ProviderConfig[] {
    return [...this.providers.values()].map((provider) => structuredClone(provider));
  }

  getProvider(id: string): ProviderConfig | undefined {
    const provider = this.providers.get(id);
    return provider ? structuredClone(provider) : undefined;
  }

  async upsertProvider(input: ProviderInput): Promise<ProviderConfig> {
    const existing = this.providers.get(input.id);
    const timestamp = this.now();
    const provider: ProviderConfig = {
      ...input,
      id: input.id,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    validateProviderConfig(provider);
    await this.store.saveProvider(provider);
    this.providers.set(provider.id, provider);
    return structuredClone(provider);
  }

  async removeProvider(id: string): Promise<void> {
    await this.store.removeProvider(id);
    this.providers.delete(id);
  }

  // ---- Model profiles ----

  listModelProfiles(): ModelProfileConfig[] {
    return [...this.modelProfiles.values()].map((profile) => structuredClone(profile));
  }

  getModelProfile(name: string): ModelProfileConfig | undefined {
    const profile = this.modelProfiles.get(name);
    return profile ? structuredClone(profile) : undefined;
  }

  /** Create or update (version increments on update). */
  async upsertModelProfile(input: ModelProfileInput): Promise<ModelProfileConfig> {
    const existing = this.modelProfiles.get(input.name);
    const timestamp = this.now();
    const profile: ModelProfileConfig = {
      ...input,
      id: existing?.id ?? `mprof_${randomUUID()}`,
      name: input.name,
      version: existing ? existing.version + 1 : 1,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    validateModelProfileConfig(profile);
    await this.store.saveModelProfile(profile);
    this.modelProfiles.set(profile.name, profile);
    return structuredClone(profile);
  }

  async removeModelProfile(name: string): Promise<void> {
    await this.store.removeModelProfile(name);
    this.modelProfiles.delete(name);
  }

  // ---- Vendor quick-add ----

  /**
   * One-form vendor registration: a Provider plus its default Model
   * Profile. The provider id is derived from the vendor name; an inline
   * `apiKey` is persisted into the host SecretStore (never into the
   * Provider record), otherwise `apiKeySecretRef` is used as-is.
   */
  async addVendor(input: VendorInput): Promise<VendorResult> {
    const name = input.name.trim();
    if (!name) {
      throw new ModelConfigValidationError("Vendor name must not be empty");
    }
    const modelName = input.modelName.trim();
    if (!modelName) {
      throw new ModelConfigValidationError("Vendor model name must not be empty");
    }
    if (input.contextWindow !== undefined
      && (!Number.isInteger(input.contextWindow) || input.contextWindow < 1)) {
      throw new ModelConfigValidationError("contextWindow must be a positive integer");
    }
    const providerId = slugify(name);

    let apiKeySecretRef = input.apiKeySecretRef;
    if (input.apiKey) {
      if (!this.secrets) {
        throw new ModelConfigValidationError(
          "apiKey was provided but no SecretStore is configured; use apiKeySecretRef instead",
        );
      }
      apiKeySecretRef = input.apiKeySecretRef ?? `${providerId.toUpperCase()}_API_KEY`;
      await this.secrets.set(apiKeySecretRef, input.apiKey);
    }

    const provider = await this.upsertProvider({
      id: providerId,
      name,
      kind: input.kind ?? "openai-compatible",
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(apiKeySecretRef ? { apiKeySecretRef } : {}),
      enabled: true,
    });
    const profileName = input.modelProfileName?.trim() || `${providerId}-default`;
    const modelProfile = await this.upsertModelProfile({
      name: profileName,
      providerId,
      modelName,
      ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      enabled: true,
    });
    return { provider, modelProfile };
  }

  // ---- Role bindings ----

  listRoleBindings(): AgentRoleBinding[] {
    return [...this.roleBindings.values()].map((binding) => structuredClone(binding));
  }

  getRoleBinding(role: string): AgentRoleBinding | undefined {
    const binding = this.roleBindings.get(role);
    return binding ? structuredClone(binding) : undefined;
  }

  /** Update the model used by a role; new tasks pick it up immediately. */
  async setRoleBinding(
    role: string,
    modelProfileId: string,
    fallbackModelProfileId?: string,
  ): Promise<AgentRoleBinding> {
    const binding: AgentRoleBinding = {
      role,
      modelProfileId,
      ...(fallbackModelProfileId ? { fallbackModelProfileId } : {}),
      priority: this.roleBindings.get(role)?.priority ?? 100,
      enabled: true,
    };
    validateRoleBinding(binding);
    await this.store.saveRoleBinding(binding);
    this.roleBindings.set(role, binding);
    return structuredClone(binding);
  }

  async removeRoleBinding(role: string): Promise<void> {
    await this.store.removeRoleBinding(role);
    this.roleBindings.delete(role);
  }

  // ---- Resolution ----

  /** Resolve a role to its enabled model profile (with optional fallback). */
  resolveRoleModel(role: string): ResolvedRoleModel | undefined {
    const binding = this.roleBindings.get(role);
    if (!binding || !binding.enabled) return undefined;
    const modelProfile = this.modelProfiles.get(binding.modelProfileId);
    if (!modelProfile || !modelProfile.enabled) return undefined;
    const fallback = binding.fallbackModelProfileId
      ? this.modelProfiles.get(binding.fallbackModelProfileId)
      : undefined;
    return {
      modelProfile: structuredClone(modelProfile),
      ...(fallback && fallback.enabled ? { fallback: structuredClone(fallback) } : {}),
      binding: structuredClone(binding),
    };
  }

  /** Enabled profiles as provider/model aliases for a fresh ModelGateway. */
  buildAliases(): ModelAliases {
    const aliases: Record<string, string> = {};
    for (const profile of this.modelProfiles.values()) {
      if (!profile.enabled) continue;
      aliases[profile.name] = `${profile.providerId}/${profile.modelName}`;
    }
    return Object.freeze(aliases);
  }

  /** CredentialResolver bound to this config and the host SecretStore. */
  createCredentialResolver(): CredentialResolver {
    return {
      resolve: async (providerId: string) => {
        const provider = this.providers.get(providerId);
        if (!provider?.apiKeySecretRef) return undefined;
        return this.secrets?.get(provider.apiKeySecretRef);
      },
    };
  }

  snapshot(): ModelConfigSnapshot {
    return {
      providers: this.listProviders(),
      modelProfiles: this.listModelProfiles(),
      roleBindings: this.listRoleBindings(),
    };
  }

  /** True when a plaintext key would otherwise leak into a saved provider. */
  hasPlaintextKey(provider: ProviderConfig): boolean {
    const record = provider as unknown as Record<string, unknown>;
    return Object.entries(record).some(
      ([key, value]) =>
        /^(?:api[_-]?key|apikey|token|key)$/i.test(key) && typeof value === "string" && value.length > 0,
    );
  }

  // Seed profiles injected by the runtime when the store is empty.
  seedModelProfiles(): void {
    for (const profile of this.defaultModelProfiles) {
      if (!this.modelProfiles.has(profile.name)) {
        this.modelProfiles.set(profile.name, profile);
      }
    }
  }
}

/** "DeepSeek API" -> "deepseek-api"; keeps provider ids URL-safe. */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new ModelConfigValidationError("Vendor name must produce a valid provider id");
  }
  return slug;
}
