import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AuthService,
  AuthError,
  FileUserStore,
  createMultiAgentRuntime,
  type MultiAgentRestApiServer,
} from "../src/index.js";
import type { IncomingMessage } from "node:http";

describe("AuthService", () => {
  it("seeds an admin, logs in, and resolves the token", async () => {
    const root = await mkdtemp(join(tmpdir(), "auth-"));
    try {
      const store = new FileUserStore(root);
      await store.seedAdmin({ username: "admin", password: "secret" });
      const auth = new AuthService(store);

      const login = await auth.login("admin", "secret");
      assert.equal(login.user.username, "admin");
      assert.equal(login.user.role, "admin");
      assert.ok(login.token.startsWith("tok_"));

      const user = await auth.userForToken(login.token);
      assert.equal(user?.username, "admin");
      // No plaintext password leaks through the public view.
      assert.equal("passwordHash" in login.user, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a wrong password", async () => {
    const root = await mkdtemp(join(tmpdir(), "auth-bad-"));
    try {
      const store = new FileUserStore(root);
      await store.seedAdmin({ username: "admin", password: "secret" });
      const auth = new AuthService(store);
      await assert.rejects(auth.login("admin", "wrong"), AuthError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates a token after logout and on expiry", async () => {
    const root = await mkdtemp(join(tmpdir(), "auth-logout-"));
    try {
      const store = new FileUserStore(root);
      await store.seedAdmin({ username: "admin", password: "secret" });
      const auth = new AuthService(store, { tokenTtlMs: 50 });

      const login = await auth.login("admin", "secret");
      assert.ok(await auth.userForToken(login.token));
      await auth.logout(login.token);
      assert.equal(await auth.userForToken(login.token), undefined);

      const login2 = await auth.login("admin", "secret");
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(await auth.userForToken(login2.token), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("REST auth endpoints", () => {
  async function startServer(): Promise<{ server: MultiAgentRestApiServer; port: number; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "auth-rest-"));
    const store = new FileUserStore(root);
    await store.seedAdmin({ username: "admin", password: "secret" });
    const auth = new AuthService(store);
    const runtime = createMultiAgentRuntime({
      auth,
      controlPlaneExecution: { cwd: process.cwd(), agentDir: join(root, "pi") },
      controlPlaneScheduler: { maxParallel: 2 },
    });
    const server = runtime.createRestApiServer({ auth, authorize: auth.authorize });
    const { port } = await server.start();
    return { server, port, root };
  }

  async function post(port: number, path: string, body: unknown, token?: string): Promise<{ status: number; data: unknown }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }

  async function get(port: number, path: string, token?: string): Promise<{ status: number; data: unknown }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, data: await response.json() };
  }

  it("login is anonymous, other routes require a token", async () => {
    const { server, port, root } = await startServer();
    try {
      // Anonymous login works.
      const login = await post(port, "/api/auth/login", { username: "admin", password: "secret" });
      assert.equal(login.status, 200);
      const { token } = login.data as { token: string };
      assert.ok(token);

      // Wrong credentials -> 401.
      const bad = await post(port, "/api/auth/login", { username: "admin", password: "nope" });
      assert.equal(bad.status, 401);

      // Protected route without a token -> 401.
      const noToken = await get(port, "/api/runs");
      assert.equal(noToken.status, 401);

      // With a token -> 200.
      const withToken = await get(port, "/api/runs", token);
      assert.equal(withToken.status, 200);

      // /api/auth/me returns the user.
      const me = await get(port, "/api/auth/me", token);
      assert.equal(me.status, 200);
      assert.equal((me.data as { username: string }).username, "admin");
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("users listing requires the admin role", async () => {
    const { server, port, root } = await startServer();
    try {
      const login = await post(port, "/api/auth/login", { username: "admin", password: "secret" });
      const { token } = login.data as { token: string };

      const users = await get(port, "/api/auth/users", token);
      assert.equal(users.status, 200);
      assert.equal((users.data as unknown[]).length, 1);
      assert.equal((users.data as { username: string }[])[0]?.username, "admin");
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a request whose Authorization header is malformed", async () => {
    const { server, port, root } = await startServer();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        headers: { Authorization: "Basic abc123" },
      });
      assert.equal(response.status, 401);
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
