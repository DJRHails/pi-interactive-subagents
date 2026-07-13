/**
 * Integration tests for the headless (no-multiplexer) spawn path.
 *
 * No mux and no LLM required: a fake `pi` binary on PATH stands in for the
 * child process, so the full loop — tool registration without a mux, headless
 * surface creation, detached background spawn, completion detection, and
 * result delivery — runs hermetically on any host, including CI.
 *
 * Covers both the happy path and the failure mode observed on headless hosts
 * (child exits at startup before writing its session file).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentsExtension from "../../pi-extension/subagents/index.ts";

const FAKE_PI_SCRIPT = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  'mkdir -p "$FAKE_PI_DIR"',
  'printf \'%s\\n\' "$@" > "$FAKE_PI_DIR/args.txt"',
  'printf \'surface=%s\\n\' "${PI_SUBAGENT_SURFACE:-}" > "$FAKE_PI_DIR/env.txt"',
  'if [ "${FAKE_PI_EXIT:-0}" != "0" ]; then',
  '  exit "${FAKE_PI_EXIT}"',
  "fi",
  'session=""',
  'prev=""',
  'for arg in "$@"; do',
  '  if [ "$prev" = "--session" ]; then session="$arg"; fi',
  '  prev="$arg"',
  "done",
  'cat > "$session" <<\'SESSION\'',
  '{"type":"session","version":3,"id":"fake-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}',
  '{"type":"message","id":"m1","message":{"role":"assistant","content":[{"type":"text","text":"HEADLESS_SUBAGENT_OK"}]}}',
  "SESSION",
  "",
].join("\n");

function createMockApi() {
  const registeredTools: any[] = [];
  const sentMessages: any[] = [];
  const api = {
    on() {},
    registerTool(tool: any) {
      registeredTools.push(tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage(message: any) {
      sentMessages.push(message);
    },
    sendUserMessage() {},
  };
  return { api, registeredTools, sentMessages };
}

async function waitForResult(sentMessages: any[], timeoutMs = 30000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const result = sentMessages.find((message) => message.customType === "subagent_result");
    if (result) return result;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for a subagent_result message`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("headless-spawn", { timeout: 120_000 }, () => {
  let root: string;
  let parentSessionFile: string;
  let ctx: any;
  const savedEnv = new Map<string, string | undefined>();

  function setEnv(name: string, value: string | undefined) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  before(() => {
    root = mkdtempSync(join(tmpdir(), "pi-headless-integ-"));

    // Fake `pi` shadows the real one for detached child spawns.
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const fakePi = join(binDir, "pi");
    writeFileSync(fakePi, FAKE_PI_SCRIPT);
    chmodSync(fakePi, 0o755);
    setEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);

    // Force the headless surface backend and isolate session storage.
    setEnv("PI_SUBAGENT_MUX", "headless");
    setEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    setEnv("FAKE_PI_EXIT", undefined);

    parentSessionFile = join(root, "parent-session.jsonl");
    writeFileSync(
      parentSessionFile,
      JSON.stringify({ type: "session", version: 3, id: "parent", cwd: root }) + "\n",
    );

    ctx = {
      cwd: root,
      sessionManager: {
        getSessionFile: () => parentSessionFile,
        getSessionId: () => "headless-integ",
        getSessionDir: () => join(root, "sessions"),
      },
    };
  });

  after(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("registers the subagent tools without a multiplexer", () => {
    const { api, registeredTools } = createMockApi();
    subagentsExtension(api as any);
    for (const name of ["subagent", "subagents_list", "subagent_resume", "subagent_interrupt"]) {
      assert.ok(
        registeredTools.some((tool) => tool.name === name),
        `expected ${name} to be registered in a headless environment`,
      );
    }
  });

  it("spawns a headless subagent and delivers its summary", async () => {
    const fakePiDir = join(root, "fake-pi-happy");
    setEnv("FAKE_PI_DIR", fakePiDir);
    setEnv("FAKE_PI_EXIT", undefined);

    const { api, registeredTools, sentMessages } = createMockApi();
    subagentsExtension(api as any);
    const tool = registeredTools.find((candidate) => candidate.name === "subagent");
    assert.ok(tool, "subagent tool not registered");

    const started = await tool.execute(
      "call-1",
      { name: "Headless Echo", task: "Say HEADLESS_SUBAGENT_OK." },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(started.details.status, "started");

    const result = await waitForResult(sentMessages);
    assert.match(result.content, /completed/);
    assert.match(result.content, /HEADLESS_SUBAGENT_OK/);
    assert.equal(result.details.exitCode, 0);

    const args = readFileSync(join(fakePiDir, "args.txt"), "utf8").split("\n");
    assert.ok(args.includes("-p"), `expected -p in child args, got: ${args.join(" ")}`);
    assert.ok(args.includes("--session"), "expected --session in child args");

    const env = readFileSync(join(fakePiDir, "env.txt"), "utf8");
    assert.match(env, /^surface=headless:/m);
  });

  it("reports a child that dies at startup instead of hanging", async () => {
    // The failure mode seen on headless hosts: the child exits with code 1
    // before writing anything to its session file.
    const fakePiDir = join(root, "fake-pi-crash");
    setEnv("FAKE_PI_DIR", fakePiDir);
    setEnv("FAKE_PI_EXIT", "1");

    const { api, registeredTools, sentMessages } = createMockApi();
    subagentsExtension(api as any);
    const tool = registeredTools.find((candidate) => candidate.name === "subagent");
    assert.ok(tool, "subagent tool not registered");

    await tool.execute(
      "call-2",
      { name: "Headless Crash", task: "This child dies immediately." },
      new AbortController().signal,
      undefined,
      ctx,
    );

    const result = await waitForResult(sentMessages);
    assert.match(result.content, /failed \(exit code 1\)/);
    assert.equal(result.details.exitCode, 1);
  });
});
