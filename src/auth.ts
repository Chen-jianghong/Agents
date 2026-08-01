/**
 * Minimal local authentication for the desktop/browser client
 * (multi-agent-development-project-plan.md §16 身份与权限).
 *
 * Users are persisted as JSON with scrypt password hashes; a login issues a
 * bearer token kept in memory. The REST server uses AuthService.authorize as
 * its authorize hook, so every API call requires a valid token. Admin
 * operations (model configuration, user management) check the role.
 */
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IncomingMessage } from "node:http";

export type UserRole = "owner" | "admin" | "developer" | "viewer";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
}

export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
}

export interface LoginResult {
  token: string;
  user: PublicUser;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthServiceOptions {
  tokenTtlMs?: number;
  now?: () => string;
}

/** JSON-file user store with scrypt password hashes. */
export class FileUserStore {
  private readonly filePath: string;

  constructor(directory: string, private readonly usersFileName = "users.json") {
    this.filePath = resolve(directory, this.usersFileName);
  }

  async list(): Promise<User[]> {
    const raw = await this.read();
    return raw.users ?? [];
  }

  async findByUsername(username: string): Promise<User | undefined> {
    const users = await this.list();
    return users.find((user) => user.username === username);
  }

  async save(user: User): Promise<void> {
    const users = await this.list();
    const existing = users.findIndex((item) => item.username === user.username);
    if (existing >= 0) {
      users[existing] = user;
    } else {
      users.push(user);
    }
    await mkdir(this.filePath.split(/[\\/]/).slice(0, -1).join("/"), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ users }, null, 2) + "\n", "utf8");
  }

  /** Seed a default admin if the store is empty. */
  async seedAdmin(options: { username: string; password: string; now?: string }): Promise<void> {
    const users = await this.list();
    if (users.some((user) => user.username === options.username)) return;
    await this.save({
      id: `user_${randomUUID()}`,
      username: options.username,
      passwordHash: hashPassword(options.password),
      role: "admin",
      createdAt: options.now ?? new Date().toISOString(),
    });
  }

  private async read(): Promise<{ users: User[] }> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { users?: User[] };
      return { users: parsed.users ?? [] };
    } catch (error) {
      if (isNotFound(error)) return { users: [] };
      throw new AuthError(`Unable to read users: ${String(error)}`);
    }
  }
}

export class AuthService {
  private readonly tokens = new Map<string, { username: string; expiresAt: number }>();
  private readonly tokenTtlMs: number;
  private readonly now: () => string;

  constructor(
    private readonly store: FileUserStore,
    options: AuthServiceOptions = {},
  ) {
    this.tokenTtlMs = options.tokenTtlMs ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const user = await this.store.findByUsername(username.trim());
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new AuthError("Invalid username or password");
    }
    const token = `tok_${randomUUID()}`;
    this.tokens.set(token, {
      username: user.username,
      expiresAt: Date.now() + this.tokenTtlMs,
    });
    return { token, user: toPublicUser(user) };
  }

  async logout(token: string): Promise<void> {
    this.tokens.delete(token);
  }

  async userForToken(token: string): Promise<User | undefined> {
    const entry = this.tokens.get(token);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.tokens.delete(token);
      return undefined;
    }
    return this.store.findByUsername(entry.username);
  }

  /** Extract the bearer token from a request, if present. */
  static tokenFromRequest(request: IncomingMessage): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match?.[1];
  }

  /** Authorize hook for the REST server: a valid bearer token is required. */
  authorize = async (request: IncomingMessage): Promise<boolean> => {
    const token = AuthService.tokenFromRequest(request);
    if (!token) return false;
    return (await this.userForToken(token)) !== undefined;
  };

  /** Role check for admin-only operations. */
  async isAdmin(request: IncomingMessage): Promise<boolean> {
    const token = AuthService.tokenFromRequest(request);
    if (!token) return false;
    const user = await this.userForToken(token);
    return user?.role === "admin" || user?.role === "owner";
  }

  /** Public user list for admin endpoints (no password hashes). */
  async listPublic(): Promise<PublicUser[]> {
    const users = await this.store.list();
    return users.map(toPublicUser);
  }
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
  };
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const separator = stored.indexOf(":");
  if (separator <= 0) return false;
  const salt = stored.slice(0, separator);
  const expected = stored.slice(separator + 1);
  const candidate = scryptSync(password, salt, 32).toString("hex");
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(candidate, "hex"));
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
