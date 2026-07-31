import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentProfile } from "./contracts.js";
import { validateProfile } from "./profile-validator.js";
import type { LayeredProfileRegistry } from "./registry.js";

export interface ProfileStoreOptions {
  projectRoot: string;
  userRoot: string;
}

export interface ProfileApproval {
  approved: true;
  approvedBy: string;
}

export class ProfilePersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfilePersistenceError";
  }
}

/**
 * The first persistence format is JSON so profiles round-trip without adding
 * a parser. The public profile contract stays independent of this file format.
 */
export class FileProfileStore {
  private readonly projectDir: string;
  private readonly userDir: string;

  constructor(options: ProfileStoreOptions) {
    this.projectDir = resolveProfileRoot(options.projectRoot);
    this.userDir = resolveProfileRoot(options.userRoot);
  }

  async loadInto(registry: LayeredProfileRegistry): Promise<AgentProfile[]> {
    const loaded: AgentProfile[] = [];
    for (const [directory, scope] of [
      [this.userDir, "user"],
      [this.projectDir, "project"],
    ] as const) {
      for (const profile of await this.readCurrentProfiles(directory)) {
        if (profile.lifecycle.scope !== scope) {
          throw new ProfilePersistenceError(
            `Profile ${profile.name} has scope ${profile.lifecycle.scope}, expected ${scope}`,
          );
        }
        registry.register(profile);
        loaded.push(profile);
      }
    }
    return loaded;
  }

  async saveApproved(profile: AgentProfile, approval: ProfileApproval): Promise<void> {
    if (profile.lifecycle.persistence !== "persistent") {
      throw new ProfilePersistenceError("Only persistent profiles can be saved");
    }
    if (profile.lifecycle.scope !== "project" && profile.lifecycle.scope !== "user") {
      throw new ProfilePersistenceError("Persistent profiles must use project or user scope");
    }
    if (!approval.approved || approval.approvedBy.trim().length === 0) {
      throw new ProfilePersistenceError("Explicit approval is required to persist a profile");
    }
    validateProfile(profile);

    const directory = profile.lifecycle.scope === "project" ? this.projectDir : this.userDir;
    const currentPath = join(directory, `${profile.name}.json`);
    const currentVersion = await this.readCurrentVersion(currentPath);
    if (currentVersion !== undefined && profile.version <= currentVersion) {
      throw new ProfilePersistenceError(
        `Profile ${profile.name} must use a higher version than ${currentVersion}`,
      );
    }
    const historyDirectory = join(directory, ".versions", profile.name);
    await mkdir(historyDirectory, { recursive: true });
    await writeFile(
      join(historyDirectory, `v${profile.version}.json`),
      JSON.stringify({
        profile,
        approvedBy: approval.approvedBy,
        savedAt: new Date().toISOString(),
      }, null, 2) + "\n",
      "utf8",
    );
    await writeFile(
      join(directory, `${profile.name}.json`),
      JSON.stringify(profile, null, 2) + "\n",
      "utf8",
    );
  }

  async removeApproved(profile: AgentProfile, approvedBy: string): Promise<void> {
    if (approvedBy.trim().length === 0) {
      throw new ProfilePersistenceError("Explicit approval is required to remove a profile");
    }
    if (profile.lifecycle.scope !== "project" && profile.lifecycle.scope !== "user") {
      throw new ProfilePersistenceError("Only project or user profiles can be removed");
    }
    const directory = profile.lifecycle.scope === "project" ? this.projectDir : this.userDir;
    const currentPath = join(directory, `${profile.name}.json`);
    const current = await this.readRequiredProfile(currentPath);
    if (current.id !== profile.id || current.version !== profile.version) {
      throw new ProfilePersistenceError(
        `Profile ${profile.name} does not match the persisted profile version`,
      );
    }
    await rm(currentPath);
  }

  private async readCurrentProfiles(directory: string): Promise<AgentProfile[]> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const profiles: AgentProfile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(directory, entry.name);
      const raw = await readFile(path, "utf8");
      let profile: AgentProfile;
      try {
        profile = JSON.parse(raw) as AgentProfile;
      } catch (error) {
        throw new ProfilePersistenceError(`Invalid JSON profile ${path}: ${String(error)}`);
      }
      try {
        validateProfile(profile);
      } catch (error) {
        throw new ProfilePersistenceError(`Invalid profile ${path}: ${String(error)}`);
      }
      profiles.push(profile);
    }
    return profiles;
  }

  private async readCurrentVersion(path: string): Promise<number | undefined> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    try {
      const profile = JSON.parse(raw) as AgentProfile;
      validateProfile(profile);
      return profile.version;
    } catch (error) {
      throw new ProfilePersistenceError(`Invalid existing profile ${path}: ${String(error)}`);
    }
  }

  private async readRequiredProfile(path: string): Promise<AgentProfile> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        throw new ProfilePersistenceError(`Persisted profile not found: ${path}`);
      }
      throw error;
    }
    try {
      const profile = JSON.parse(raw) as AgentProfile;
      validateProfile(profile);
      return profile;
    } catch (error) {
      if (error instanceof ProfilePersistenceError) throw error;
      throw new ProfilePersistenceError(`Invalid existing profile ${path}: ${String(error)}`);
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function resolveProfileRoot(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}
