import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// Compiled tests run from dist/test/, so go up two levels to the repo root.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "examples", "e2e-real-provider.mjs");

function runScript(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Env without any provider API key, so the script cannot pick one up. */
function withoutKeys(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    "E2E_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "MOONSHOT_API_KEY",
    "ZAI_API_KEY",
    "GEMINI_API_KEY",
  ]) {
    env[key] = undefined;
  }
  return env;
}

describe("e2e-real-provider.mjs", () => {
  it("runs the full loop in self-test mode without external models", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "e2e-selftest-"));
    try {
      const result = await runScript(
        ["--self-test", "--workspace", workspace],
        withoutKeys(),
      );
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /端到端验证通过/);
      assert.match(result.stdout, /run\.succeeded/);
      assert.match(result.stdout, /tokens=\d+/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("exits with a clear guidance error when no API key is configured", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "e2e-nokey-"));
    try {
      const result = await runScript(
        ["--provider", "deepseek", "--workspace", workspace],
        withoutKeys(),
      );
      assert.equal(result.code, 1);
      const output = result.stdout + result.stderr;
      assert.match(output, /缺少 API Key/);
      assert.match(output, /DEEPSEEK_API_KEY/);
      assert.match(output, /--self-test/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an unknown provider", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "e2e-badprovider-"));
    try {
      const result = await runScript(
        ["--provider", "not-a-provider", "--workspace", workspace],
        withoutKeys(),
      );
      assert.equal(result.code, 2);
      assert.match(result.stderr, /不支持的 provider/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs the Worker demo end to end (worker-entry + worker-demo)", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "worker-demo-"));
    try {
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [join(root, "examples", "worker-demo.mjs")], {
          cwd: root,
          env: {
            ...withoutKeys(),
            WORKER_WORKSPACE: workspace,
            PATH: process.env.PATH,
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /worker started/);
      assert.match(result.stdout, /profiles: researcher, coder, tester, reviewer/);
      assert.match(result.stdout, /run_agent: \{"agentId":"builtin_researcher"/);
      assert.match(result.stdout, /result: \{"agentId":"builtin_researcher".*"status":"completed"/);
      assert.match(result.stdout, /worker stopped/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
