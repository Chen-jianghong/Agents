import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  AgentControlPlane,
  createMultiAgentRuntime,
  FileModelConfigStore,
  ModelConfigService,
  MultiAgentRestApiServer,
  PiAgentManager,
  type SecretStore,
} from "../src/index.js";

function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async (ref) => values.get(ref),
    set: async (ref, value) => { values.set(ref, value); },
    delete: async (ref) => { values.delete(ref); },
  };
}

function makeControlPlane(runtime: ReturnType<typeof createMultiAgentRuntime>) {
  return new AgentControlPlane(runtime.registry, new PiAgentManager({
    create: async (profile, task) => ({
      agentId: profile.id,
      sessionId: "s",
      profile,
      session: {} as never,
      status: "created",
      prompt: async () => ({
        agentId: profile.id,
        agentTaskId: task.id,
        status: "completed",
        changedFiles: [],
        tests: [],
        risks: [],
      }),
      cancel: async () => undefined,
      subscribe: () => () => undefined,
    }),
  }));
}

describe("Model configuration REST API", () => {
  let root: string;
  let server: MultiAgentRestApiServer;
  let baseUrl: string;
  let modelConfig: ModelConfigService;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "model-rest-"));
    const runtime = createMultiAgentRuntime();
    modelConfig = new ModelConfigService({
      store: new FileModelConfigStore(join(root, "models")),
      now: () => new Date().toISOString(),
    });
    const controlPlane = new AgentControlPlane(runtime.registry, new PiAgentManager({
      create: async (profile, task) => ({
        agentId: profile.id,
        sessionId: "s",
        profile,
        session: {} as never,
        status: "created",
        prompt: async () => ({
          agentId: profile.id,
          agentTaskId: task.id,
          status: "completed",
          changedFiles: [],
          tests: [],
          risks: [],
        }),
        cancel: async () => undefined,
        subscribe: () => () => undefined,
      }),
    }));
    server = new MultiAgentRestApiServer(controlPlane, { modelConfig });
    const address = await server.start();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });

  async function jsonFetch(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }

  it("lists providers and model profiles", async () => {
    const providers = await jsonFetch("/api/model/providers");
    assert.equal(providers.status, 200);
    assert.ok(Array.isArray(providers.body));

    const profiles = await jsonFetch("/api/model/profiles");
    assert.equal(profiles.status, 200);
    assert.ok(Array.isArray(profiles.body));
  });

  it("upserts and deletes a provider without plaintext keys", async () => {
    const saved = await jsonFetch("/api/model/providers/deepseek", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "DeepSeek",
        kind: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        apiKeySecretRef: "DEEPSEEK_API_KEY",
        enabled: true,
      }),
    });
    assert.equal(saved.status, 200);
    const provider = saved.body as { id: string; name: string; enabled: boolean };
    assert.equal(provider.id, "deepseek");
    assert.equal(provider.name, "DeepSeek");

    const read = await jsonFetch("/api/model/providers/deepseek");
    assert.equal(read.status, 200);
    assert.equal((read.body as { id: string }).id, "deepseek");

    const listed = await jsonFetch("/api/model/providers");
    assert.ok(
      (listed.body as Array<{ id: string }>).some((item) => item.id === "deepseek"),
    );

    const deleted = await jsonFetch("/api/model/providers/deepseek", { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { deleted: "deepseek" });
  });

  it("rejects a provider with a plaintext apiKey", async () => {
    const response = await jsonFetch("/api/model/providers/bad", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad",
        kind: "openai-compatible",
        apiKey: "sk-plaintext",
        enabled: true,
      }),
    });
    assert.equal(response.status, 422);
  });

  it("upserts and reads model profiles", async () => {
    const saved = await jsonFetch("/api/model/profiles/coding-balanced", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "deepseek",
        modelName: "deepseek-chat",
        reasoningEffort: "medium",
        enabled: true,
      }),
    });
    assert.equal(saved.status, 200);
    const profile = saved.body as { name: string; modelName: string; version: number };
    assert.equal(profile.name, "coding-balanced");
    assert.equal(profile.modelName, "deepseek-chat");
    assert.ok(profile.version >= 1);

    const read = await jsonFetch("/api/model/profiles/coding-balanced");
    assert.equal(read.status, 200);
    assert.equal((read.body as { name: string }).name, "coding-balanced");

    const missing = await jsonFetch("/api/model/profiles/nope");
    assert.equal(missing.status, 404);

    const deleted = await jsonFetch("/api/model/profiles/coding-balanced", { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { deleted: "coding-balanced" });
  });

  it("lists, binds and removes role bindings", async () => {
    const listed = await jsonFetch("/api/model/role-bindings");
    assert.equal(listed.status, 200);
    const bindings = listed.body as Array<{ role: string }>;
    assert.ok(bindings.some((binding) => binding.role === "backend"));

    const bound = await jsonFetch("/api/model/role-bindings/backend", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelProfileId: "coding-strong",
        fallbackModelProfileId: "coding-balanced",
      }),
    });
    assert.equal(bound.status, 200);
    const binding = bound.body as { role: string; modelProfileId: string; fallbackModelProfileId: string };
    assert.equal(binding.role, "backend");
    assert.equal(binding.modelProfileId, "coding-strong");
    assert.equal(binding.fallbackModelProfileId, "coding-balanced");

    const read = await jsonFetch("/api/model/role-bindings/backend");
    assert.equal(read.status, 200);
    assert.equal((read.body as { modelProfileId: string }).modelProfileId, "coding-strong");

    const removed = await jsonFetch("/api/model/role-bindings/backend", { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { deleted: "backend" });
  });

  it("validates role binding requests", async () => {
    const missing = await jsonFetch("/api/model/role-bindings/backend", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 422);
  });

  it("returns 503 when the model config center is not configured", async () => {
    const runtime = createMultiAgentRuntime();
    const controlPlane = new AgentControlPlane(runtime.registry, new PiAgentManager({
      create: async (profile, task) => ({
        agentId: profile.id,
        sessionId: "s",
        profile,
        session: {} as never,
        status: "created",
        prompt: async () => ({
          agentId: profile.id,
          agentTaskId: task.id,
          status: "completed",
          changedFiles: [],
          tests: [],
          risks: [],
        }),
        cancel: async () => undefined,
        subscribe: () => () => undefined,
      }),
    }));
    const bare = new MultiAgentRestApiServer(controlPlane);
    const address = await bare.start();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/model/providers`);
      assert.equal(response.status, 503);
    } finally {
      await bare.stop();
    }
  });

  it("adds a vendor with an inline API key stored in the SecretStore", async () => {
    const runtime = createMultiAgentRuntime();
    const secrets = memorySecrets();
    const vendorConfig = new ModelConfigService({
      store: new FileModelConfigStore(join(root, "models-vendor")),
      secrets,
      now: () => new Date().toISOString(),
    });
    const vendorServer = new MultiAgentRestApiServer(makeControlPlane(runtime), {
      modelConfig: vendorConfig,
    });
    const address = await vendorServer.start();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/model/vendors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "DeepSeek API",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-inline-key",
          modelName: "deepseek-chat",
          contextWindow: 65536,
        }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        provider: { id: string; name: string; baseUrl: string; apiKeySecretRef: string };
        modelProfile: { name: string; providerId: string; modelName: string; contextWindow: number };
      };
      // Provider id derived from the name; no plaintext key in the record.
      assert.equal(body.provider.id, "deepseek-api");
      assert.equal(body.provider.name, "DeepSeek API");
      assert.equal(body.provider.baseUrl, "https://api.deepseek.com");
      assert.equal(body.provider.apiKeySecretRef, "DEEPSEEK-API_API_KEY");
      assert.ok(!JSON.stringify(body.provider).includes("sk-inline-key"), "no plaintext key in provider");

      // The key landed in the SecretStore, not in the config record.
      assert.equal(secrets.values.get("DEEPSEEK-API_API_KEY"), "sk-inline-key");

      // Default model profile was created for the vendor.
      assert.equal(body.modelProfile.name, "deepseek-api-default");
      assert.equal(body.modelProfile.providerId, "deepseek-api");
      assert.equal(body.modelProfile.modelName, "deepseek-chat");
      assert.equal(body.modelProfile.contextWindow, 65536);
    } finally {
      await vendorServer.stop();
    }
  });

  it("adds a vendor without an API key (anonymous/local provider)", async () => {
    const runtime = createMultiAgentRuntime();
    const vendorConfig = new ModelConfigService({
      store: new FileModelConfigStore(join(root, "models-vendor-anon")),
      now: () => new Date().toISOString(),
    });
    const vendorServer = new MultiAgentRestApiServer(makeControlPlane(runtime), {
      modelConfig: vendorConfig,
    });
    const address = await vendorServer.start();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/model/vendors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Ollama",
          baseUrl: "http://127.0.0.1:11434",
          modelName: "qwen2.5:7b",
          modelProfileName: "local-coder",
        }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        provider: { id: string; apiKeySecretRef?: string };
        modelProfile: { name: string };
      };
      assert.equal(body.provider.id, "ollama");
      assert.equal(body.provider.apiKeySecretRef, undefined);
      assert.equal(body.modelProfile.name, "local-coder");
    } finally {
      await vendorServer.stop();
    }
  });

  it("rejects a vendor with an inline API key when no SecretStore is configured", async () => {
    const response = await jsonFetch("/api/model/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "NoStore",
        apiKey: "sk-xxx",
        modelName: "m",
      }),
    });
    assert.equal(response.status, 422);
    assert.match((response.body as { error: { message: string } }).error.message, /SecretStore/);
  });

  it("validates vendor input", async () => {
    const emptyName = await jsonFetch("/api/model/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  ", modelName: "m" }),
    });
    assert.equal(emptyName.status, 422);

    const badWindow = await jsonFetch("/api/model/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X", modelName: "m", contextWindow: -5 }),
    });
    assert.equal(badWindow.status, 422);

    const badMethod = await jsonFetch("/api/model/vendors", { method: "GET" });
    assert.equal(badMethod.status, 405);
  });

  it("serves the vendor registration form at /ui/vendors", async () => {
    const response = await fetch(`${baseUrl}/ui/vendors`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /手动添加供应商/);
    assert.match(html, /name="name"/);
    assert.match(html, /name="baseUrl"/);
    assert.match(html, /name="apiKey"/);
    assert.match(html, /name="modelName"/);
    assert.match(html, /name="contextWindow"/);
    assert.match(html, /\/api\/model\/vendors/);
  });
});
