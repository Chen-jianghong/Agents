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
} from "../src/index.js";

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
});
