import { test, describe, it as _it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiAgentRuntime, FileUserStore, AuthService } from "../src/index.js";

async function make() {
  const root = await mkdtemp(join(tmpdir(), "auth-order-"));
  const store = new FileUserStore(root);
  await store.seedAdmin({ username: "admin", password: "secret" });
  const auth = new AuthService(store);
  const runtime = createMultiAgentRuntime({ auth });
  const server = runtime.createRestApiServer({ auth, authorize: auth.authorize });
  const { port } = await server.start();
  return { server, port, root };
}

describe("order test", () => {
  _it("first", async () => {
    const { server, port, root } = await make();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      });
      console.log("FIRST login status:", res.status, "body:", (await res.text()).slice(0, 120));
      assert.equal(res.status, 200);
    } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
  });
  _it("second", async () => {
    const { server, port, root } = await make();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      });
      console.log("SECOND login status:", res.status);
      assert.equal(res.status, 200);
    } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
