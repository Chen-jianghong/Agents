import type {
  AgentTask,
  CreateAgentRequest,
  EffectiveProfileResult,
} from "./contracts.js";
import { AgentFactory } from "./factory.js";
import {
  FileProfileStore,
  ProfilePersistenceError,
  type ProfileApproval,
} from "./profile-store.js";
import type { ProfileRegistry } from "./registry.js";

/**
 * Host-owned boundary for persistent profiles. Main Agent tools receive the
 * regular factory and therefore cannot reach this service accidentally.
 */
export class PersistentProfileService {
  private readonly persistentFactory: AgentFactory;

  constructor(
    factory: AgentFactory,
    private readonly registry: ProfileRegistry,
    private readonly store: FileProfileStore,
  ) {
    this.persistentFactory = factory.withPersistentProfiles();
  }

  async createApproved(
    request: CreateAgentRequest,
    task: AgentTask,
    approval: ProfileApproval,
  ): Promise<EffectiveProfileResult> {
    assertApproval(approval);
    assertPersistentRequest(request);

    const created = this.persistentFactory.createProfile(request, task);
    try {
      await this.store.saveApproved(created.profile, approval);
      return created;
    } catch (error) {
      // Factory registration happens before persistence so the profile can be
      // used immediately. Do not leave a usable in-memory profile behind when
      // the durable write fails.
      this.registry.remove(created.profile.id);
      throw error;
    }
  }

  async removeApproved(nameOrId: string, approvedBy: string): Promise<void> {
    if (approvedBy.trim().length === 0) {
      throw new ProfilePersistenceError("Explicit approval is required to remove a profile");
    }

    const profile = this.registry.get(nameOrId);
    if (profile.lifecycle.persistence !== "persistent") {
      throw new ProfilePersistenceError("Only persistent profiles can be removed");
    }
    if (profile.lifecycle.scope !== "project" && profile.lifecycle.scope !== "user") {
      throw new ProfilePersistenceError("Only project or user profiles can be removed");
    }

    await this.store.removeApproved(profile, approvedBy);
    this.registry.remove(profile.id);
  }
}

function assertApproval(approval: ProfileApproval): void {
  if (!approval.approved || approval.approvedBy.trim().length === 0) {
    throw new ProfilePersistenceError("Explicit approval is required to persist a profile");
  }
}

function assertPersistentRequest(request: CreateAgentRequest): void {
  if (request.persistence !== "persistent") {
    throw new ProfilePersistenceError("PersistentProfileService only accepts persistent profiles");
  }
  if (request.scope !== "project" && request.scope !== "user") {
    throw new ProfilePersistenceError("Persistent profiles must use project or user scope");
  }
  if (request.createdBy === "main-agent") {
    throw new ProfilePersistenceError("Main Agent cannot create persistent profiles");
  }
}
