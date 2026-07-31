import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileModelConfigStore,
  ModelConfigPersistenceError,
  ModelConfigValidationError,
  type AgentRoleBinding,
  type ModelProfileConfig,
  type ProviderConfig,
} from "../src/model-config.js";
import { ModelConfigService, type SecretStore } from "../src/model-config-service.js";

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "provider-1",
    name: "Test Provider",
    kind: "openai-compatible",
    apiKeySecretRef: "PROVIDER_1_KEY",
    enabled: true,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

function modelProfile(overrides: Partial<ModelProfileConfig> = {}): ModelProfileConfig {
  return {
    id: "mprof_1",
    name: "coding-balanced",
    providerId: "provider-1",
    modelName: "deepseek-chat",
    enabled: true,
    version: 1,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

async function tempStore(): Promise<{ root: string; store: FileModelConfigStore }> {
  const root = await mkdtemp(join(tmpdir(), "model-config-"));
  return { root, store: new FileModelConfigStore(root) };
}

class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async get(ref: string): Promise<string | undefined> {
    return this.values.get(ref);
  }
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
}

describe("FileModelConfigStore", () => {
  it("round-trips providers, model profiles and role bindings", async () => {
    const { root, store } = await tempStore();
    try {
      await store.saveProvider(provider());
      await store.saveModelProfile(modelProfile());
      const binding: AgentRoleBinding = {
        role: "backend",
        modelProfileId: "coding-balanced",
        priority: 100,
        enabled: true,
      };
      await store.saveRoleBinding(binding);

      const snapshot = await store.loadAll();
      assert.equal(snapshot.providers.length, 1);
      assert.equal(snapshot.modelProfiles.length, 1);
      assert.equal(snapshot.roleBindings.length, 1);
      assert.equal(snapshot.providers[0]?.apiKeySecretRef, "PROVIDER_1_KEY");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a provider with a plaintext apiKey", async () => {
    const { root, store } = await tempStore();
    try {
      const bad = { ...provider(), apiKeySecretRef: undefined, apiKey: "sk-plaintext" };
      await assert.rejects(
        store.saveProvider(bad as unknown as ProviderConfig),
        ModelConfigValidationError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a model profile with a lower or equal version", async () => {
    const { root, store } = await tempStore();
    try {
      await store.saveModelProfile(modelProfile({ version: 2 }));
      await assert.rejects(
        store.saveModelProfile(modelProfile({ version: 2 })),
        ModelConfigPersistenceError,
      );
      await assert.rejects(
        store.saveModelProfile(modelProfile({ version: 1 })),
        ModelConfigPersistenceError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an empty snapshot for a missing directory", async () => {
    const { root, store } = await tempStore();
    try {
      const snapshot = await store.loadAll();
      assert.deepEqual(snapshot, { providers: [], modelProfiles: [], roleBindings: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ModelConfigService", () => {
  it("loads defaults and persists updates", async () => {
    const { root, store } = await tempStore();
    try {
      const service = new ModelConfigService({ store });
      await service.load();

      // Built-in role bindings exist without persisted files.
      assert.ok(service.getRoleBinding("planner"));
      assert.equal(service.listRoleBindings().length, 10);

      await service.upsertProvider(provider());
      await service.upsertModelProfile(modelProfile());
      await service.setRoleBinding("backend", "coding-balanced");

      const reloaded = new ModelConfigService({ store });
      const snapshot = await reloaded.load();
      assert.equal(snapshot.providers.length, 1);
      assert.equal(snapshot.modelProfiles.length, 1);
      // Built-in role bindings persist in memory; the persisted one overrides.
      assert.ok(
        snapshot.roleBindings.some((binding) => binding.role === "backend"),
        "backend binding present after reload",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("increments the version on model profile updates", async () => {
    const { root, store } = await tempStore();
    try {
      const service = new ModelConfigService({ store });
      await service.load();
      await service.upsertProvider(provider());
      const first = await service.upsertModelProfile(modelProfile());
      assert.equal(first.version, 1);
      const second = await service.upsertModelProfile(modelProfile());
      assert.equal(second.version, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds aliases only from enabled profiles", async () => {
    const { root, store } = await tempStore();
    try {
      const service = new ModelConfigService({ store });
      await service.load();
      await service.upsertProvider(provider());
      await service.upsertModelProfile(modelProfile({ name: "coding-strong", modelName: "claude-sonnet" }));
      await service.upsertModelProfile(modelProfile({ name: "disabled-model", modelName: "x", enabled: false }));

      const aliases = service.buildAliases();
      assert.equal(aliases["coding-strong"], "provider-1/claude-sonnet");
      assert.equal(aliases["disabled-model"], undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a role to its enabled model with fallback", async () => {
    const { root, store } = await tempStore();
    try {
      const service = new ModelConfigService({ store });
      await service.load();
      await service.upsertProvider(provider());
      await service.upsertModelProfile(modelProfile({ name: "main-model", modelName: "m" }));
      await service.upsertModelProfile(modelProfile({ name: "fallback-model", modelName: "f" }));
      await service.setRoleBinding("backend", "main-model", "fallback-model");

      const resolved = service.resolveRoleModel("backend");
      assert.equal(resolved?.modelProfile.modelName, "m");
      assert.equal(resolved?.fallback?.modelName, "f");

      // Disabling the binding hides the role.
      await service.setRoleBinding("backend", "main-model");
      const binding = service.getRoleBinding("backend")!;
      await service.setRoleBinding(binding.role, "main-model");
      service.snapshot();
      const disabled = { ...binding, enabled: false };
      await store.saveRoleBinding(disabled);
      const reloaded = new ModelConfigService({ store });
      await reloaded.load();
      assert.equal(reloaded.resolveRoleModel("backend"), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves credentials through the host SecretStore", async () => {
    const { root, store } = await tempStore();
    try {
      const secrets = new MemorySecretStore();
      await secrets.set("PROVIDER_1_KEY", "sk-secret-value");
      const service = new ModelConfigService({ store, secrets });
      await service.load();
      await service.upsertProvider(provider());

      const resolver = service.createCredentialResolver();
      assert.equal(await resolver.resolve("provider-1"), "sk-secret-value");
      assert.equal(await resolver.resolve("unknown-provider"), undefined);
      assert.equal(await resolver.resolve("provider-no-secret"), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
