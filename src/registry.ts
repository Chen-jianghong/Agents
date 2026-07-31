import type { AgentProfile } from "./contracts.js";
import { validateProfile, ProfileValidationError } from "./profile-validator.js";

export class ProfileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileConflictError";
  }
}

export class ProfileNotFoundError extends Error {
  constructor(nameOrId: string) {
    super(`Agent profile not found: ${nameOrId}`);
    this.name = "ProfileNotFoundError";
  }
}

export interface ProfileRegistry {
  register(profile: AgentProfile): AgentProfile;
  get(nameOrId: string): AgentProfile;
  list(): AgentProfile[];
  remove(nameOrId: string): void;
}

/**
 * Resolves built-in, user, project, and task-scoped profiles without letting
 * one scope mutate another. Higher-precedence scopes shadow lower ones by name.
 */
export class LayeredProfileRegistry implements ProfileRegistry {
  private readonly builtins = new Map<string, AgentProfile>();
  private readonly user = new Map<string, AgentProfile>();
  private readonly project = new Map<string, AgentProfile>();
  private readonly runtime = new Map<string, AgentProfile>();

  registerBuiltIn(profile: AgentProfile): AgentProfile {
    validateProfile(profile);
    return this.put(this.builtins, profile);
  }

  register(profile: AgentProfile): AgentProfile {
    validateProfile(profile);
    const target = profile.lifecycle.scope === "user"
      ? this.user
      : profile.lifecycle.scope === "project"
        ? this.project
        : this.runtime;
    return this.put(target, profile);
  }

  get(nameOrId: string): AgentProfile {
    const profile = this.findVisible(nameOrId);
    if (!profile) throw new ProfileNotFoundError(nameOrId);
    return structuredClone(profile);
  }

  list(): AgentProfile[] {
    const visible = new Map<string, AgentProfile>();
    for (const layer of [this.runtime, this.project, this.user, this.builtins]) {
      for (const profile of layer.values()) {
        if (!visible.has(profile.name)) visible.set(profile.name, profile);
      }
    }
    return [...visible.values()].map((profile) => structuredClone(profile));
  }

  remove(nameOrId: string): void {
    for (const layer of [this.runtime, this.project, this.user, this.builtins]) {
      const profile = this.findInLayer(layer, nameOrId);
      if (profile) {
        layer.delete(profile.id);
        return;
      }
    }
    throw new ProfileNotFoundError(nameOrId);
  }

  private put(target: Map<string, AgentProfile>, profile: AgentProfile): AgentProfile {
    const existing = this.findInLayer(target, profile.name);
    if (existing && existing.id !== profile.id) {
      throw new ProfileConflictError(`Profile ${profile.name} already exists in its scope`);
    }
    if (existing && profile.version <= existing.version) {
      throw new ProfileConflictError(`Profile ${profile.name} must use a higher version than ${existing.version}`);
    }
    const snapshot = structuredClone(profile);
    target.set(snapshot.id, snapshot);
    return structuredClone(snapshot);
  }

  private findVisible(nameOrId: string): AgentProfile | undefined {
    for (const layer of [this.runtime, this.project, this.user, this.builtins]) {
      const profile = this.findInLayer(layer, nameOrId);
      if (profile) return profile;
    }
    return undefined;
  }

  private findInLayer(layer: Map<string, AgentProfile>, nameOrId: string): AgentProfile | undefined {
    return layer.get(nameOrId) ?? [...layer.values()].find((profile) => profile.name === nameOrId);
  }
}

export class InMemoryProfileRegistry implements ProfileRegistry {
  private readonly profiles = new Map<string, AgentProfile>();

  register(profile: AgentProfile): AgentProfile {
    validateProfile(profile);
    const existing = this.profiles.get(profile.id) ?? [...this.profiles.values()].find((item) => item.name === profile.name && item.lifecycle.scope === profile.lifecycle.scope);

    if (existing && existing.id !== profile.id) {
      throw new ProfileConflictError(`Profile ${profile.name} already exists in ${profile.lifecycle.scope} scope`);
    }

    if (existing && profile.version <= existing.version) {
      throw new ProfileConflictError(`Profile ${profile.name} must use a higher version than ${existing.version}`);
    }

    this.profiles.set(profile.id, structuredClone(profile));
    return structuredClone(profile);
  }

  get(nameOrId: string): AgentProfile {
    const profile = this.profiles.get(nameOrId) ?? [...this.profiles.values()].find((item) => item.name === nameOrId);
    if (!profile) throw new ProfileNotFoundError(nameOrId);
    return structuredClone(profile);
  }

  list(): AgentProfile[] {
    return [...this.profiles.values()].map((profile) => structuredClone(profile));
  }

  remove(nameOrId: string): void {
    const profile = this.get(nameOrId);
    this.profiles.delete(profile.id);
  }
}
