import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createMultiAgentRuntimeAsync, FileModelConfigStore } from "../src/index.js";
import type { ModelProfileConfig } from "../src/model-config.js";

const NOW = "2026-07-31T00:00:00.000Z";

function defaultProfiles(providerId: string): ModelProfileConfig[] {
  return [
    {
      id: "mprof_strong",
      name: "coding-strong",
      providerId,
      modelName: "faux-model",
      reasoningEffort: "high",
      enabled: true,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "mprof_balanced",
      name: "coding-balanced",
      providerId,
      modelName: "faux-model",
      reasoningEffort: "medium",
      enabled: true,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
}

const DAG = {
  goal: "Implement members management",
  tasks: [
    {
      id: "backend",
      title: "Implement the members API",
      role: "backend",
      dependsOn: [],
      writePaths: ["server/modules/members"],
      acceptanceCriteria: ["list endpoint returns members"],
      testCommands: ["npm test"],
    },
    {
      id: "qa",
      title: "Verify",
      role: "qa",
      dependsOn: ["backend"],
      writePaths: [],
      acceptanceCriteria: ["tests pass"],
      testCommands: ["npm test"],
    },
  ],
};

describe("Phase C integration (model config center)", () => {
  it("drives new sessions from the config center and picks up changes", async () => {
    const faux = fauxProvider({ provider: "faux-cfg", models: [{ id: "faux-model", reasoning: false }] });
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const root = await mkdtemp(join(tmpdir(), "phase-c-"));
    try {
      const store = new FileModelConfigStore(root);
      const runtime = await createMultiAgentRuntimeAsync({
        modelRuntime,
        modelConfigStore: store,
        defaultModelProfiles: defaultProfiles("faux-cfg"),
      });

      // Config center exposed with seeded defaults and role bindings.
      assert.ok(runtime.modelConfig, "modelConfig service available");
      assert.equal(runtime.modelConfig!.buildAliases()["coding-strong"], "faux-cfg/faux-model");
      assert.ok(runtime.modelConfig!.getRoleBinding("planner"), "default role binding seeded");

      // First Run: real Planner + RunScheduler + Manager using config aliases.
      faux.setResponses([
        fauxAssistantMessage(JSON.stringify(DAG)),
        fauxAssistantMessage("Backend done."),
        fauxAssistantMessage("QA passed."),
      ]);
      const scheduler = runtime.createRunScheduler({
        workspace: process.cwd(),
        agentDir: join(root, "pi"),
        maxParallel: 1,
      });
      const run = scheduler.createRun({ goal: DAG.goal, workspace: process.cwd(), agentDir: join(root, "pi"), maxParallel: 1 });
      await scheduler.startRun(run.runId);
      const first = await scheduler.waitForRun(run.runId);
      assert.equal(first.status, "succeeded");

      // Config change: point coding-balanced at a new model name.
      const updated = await runtime.modelConfig!.upsertModelProfile({
        name: "coding-balanced",
        providerId: "faux-cfg",
        modelName: "faux-model-v2",
        reasoningEffort: "medium",
        enabled: true,
      });
      assert.equal(updated.version, 2);
      assert.equal(runtime.modelConfig!.buildAliases()["coding-balanced"], "faux-cfg/faux-model-v2");

      // Persisted across a fresh runtime (async bootstrap loads the store).
      const runtime2 = await createMultiAgentRuntimeAsync({
        modelRuntime,
        modelConfigStore: store,
        defaultModelProfiles: defaultProfiles("faux-cfg"),
      });
      assert.equal(runtime2.modelConfig!.buildAliases()["coding-balanced"], "faux-cfg/faux-model-v2");

      // A new scheduler (new Run) uses the updated aliases and still works.
      faux.setResponses([
        fauxAssistantMessage(JSON.stringify(DAG)),
        fauxAssistantMessage("Backend done (v2)."),
        fauxAssistantMessage("QA passed (v2)."),
      ]);
      const scheduler2 = runtime2.createRunScheduler({
        workspace: process.cwd(),
        agentDir: join(root, "pi2"),
        maxParallel: 1,
      });
      const run2 = scheduler2.createRun({ goal: DAG.goal, workspace: process.cwd(), agentDir: join(root, "pi2"), maxParallel: 1 });
      await scheduler2.startRun(run2.runId);
      const second = await scheduler2.waitForRun(run2.runId);
      assert.equal(second.status, "succeeded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves credentials for providers configured in the center", async () => {
    const faux = fauxProvider({ provider: "faux-cfg-secret", models: [{ id: "faux-model", reasoning: false }] });
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const root = await mkdtemp(join(tmpdir(), "phase-c-secret-"));
    try {
      const store = new FileModelConfigStore(root);
      const secrets = {
        async get(ref: string): Promise<string | undefined> {
          return ref === "CFG_KEY" ? "sk-configured" : undefined;
        },
        async set(): Promise<void> {},
        async delete(): Promise<void> {},
      };
      const runtime = await createMultiAgentRuntimeAsync({
        modelRuntime,
        modelConfigStore: store,
        secrets,
        defaultModelProfiles: defaultProfiles("faux-cfg-secret"),
      });
      await runtime.modelConfig!.upsertProvider({
        id: "faux-cfg-secret",
        name: "Secret Provider",
        kind: "faux",
        apiKeySecretRef: "CFG_KEY",
        enabled: true,
      });
      const resolver = runtime.modelConfig!.createCredentialResolver();
      assert.equal(await resolver.resolve("faux-cfg-secret"), "sk-configured");
      assert.equal(await resolver.resolve("missing"), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
