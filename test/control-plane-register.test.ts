import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMultiAgentRuntime, CONTROL_PLANE_VERSION, PiAgentManager, type AgentProfile } from "../src/index.js";
import { AgentControlPlane } from "../src/control-plane.js";

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent_register_1",
    name: "register-me",
    version: 1,
    description: "Test profile",
    kind: "subagent",
    identity: {
      responsibilities: ["Read"],
      nonResponsibilities: [],
      systemPrompt: "You are a test agent.",
    },
    execution: {
      model: "coding-balanced",
      thinkingLevel: "medium",
      tools: ["read"],
      readOnly: true,
      writePaths: [],
      canDelegate: false,
      maxDepth: 1,
    },
    output: {
      format: "text",
      requiredSections: [],
      requiredFields: [],
      acceptanceCriteriaRequired: true,
      reportChangedFiles: false,
      reportTests: true,
      reportRisks: true,
    },
    limits: {
      maxTurns: 20,
      timeoutSeconds: 60,
      maxConcurrentChildren: 0,
    },
    context: {
      includeParentSummary: true,
      includeTaskFiles: [],
      loadProjectInstructions: true,
      memoryMode: "read",
    },
    lifecycle: {
      persistence: "ephemeral",
      scope: "task",
      createdBy: "system",
      createdAt: "2026-07-31T00:00:00.000Z",
    },
    ...overrides,
  };
}

function setupControlPlane() {
  const runtime = createMultiAgentRuntime();
  const manager = new PiAgentManager({ create: async () => {
    throw new Error("session should not be created in this test");
  } });
  return { runtime, manager, controlPlane: new AgentControlPlane(runtime.registry, manager) };
}

describe("Control Plane register_profile", () => {
  it("registers a profile snapshot and returns its identity", async () => {
    const { controlPlane } = setupControlPlane();
    const p = profile();
    const response = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "register-1",
      type: "register_profile",
      profile: p,
    });
    assert.equal(response.ok, true);
    if (!response.ok) return;
    const registered = response.data as { profileId: string; version: number };
    assert.equal(registered.profileId, p.id);
    assert.equal(registered.version, 1);
    // The profile is now resolvable by id.
    const listed = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "list-1",
      type: "list_profiles",
    });
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.ok((listed.data as { id: string }[]).some((item) => item.id === p.id));
  });

  it("rejects a malformed profile", async () => {
    const { controlPlane } = setupControlPlane();
    const bad = { ...profile(), name: "" } as unknown;
    const response = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "register-bad",
      type: "register_profile",
      profile: bad,
    });
    assert.equal(response.ok, false);
    if (response.ok) return;
    assert.equal(response.error.code, "invalid_request");
  });

  it("returns a failure for a conflicting registration", async () => {
    const { controlPlane } = setupControlPlane();
    const first = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "register-first",
      type: "register_profile",
      profile: profile(),
    });
    assert.equal(first.ok, true);
    // Same name, different id -> conflict in the registry layer.
    const conflict = await controlPlane.handle({
      version: CONTROL_PLANE_VERSION,
      requestId: "register-conflict",
      type: "register_profile",
      profile: profile({ id: "agent_register_2" }),
    });
    assert.equal(conflict.ok, false);
    if (conflict.ok) return;
    assert.equal(conflict.error.code, "control_plane_error");
    assert.match(conflict.error.message, /already exists/i);
  });
});
