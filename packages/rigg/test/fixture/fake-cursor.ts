import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

type FakeAcpStep =
  | {
      kind: "delay"
      ms: number
    }
  | {
      kind: "notification"
      method: string
      params?: Record<string, unknown> | undefined
    }
  | {
      expectResult?: Record<string, unknown> | undefined
      kind: "request"
      method: string
      params?: Record<string, unknown> | undefined
      requestId?: string | number | undefined
    }
  | {
      kind: "stderr"
      text: string
    }
  | {
      kind: "stdout"
      text: string
    }

type SessionPromptDefinition = {
  dispatch?: "deferred" | "immediate" | undefined
  error?: { code?: number | undefined; message?: string | undefined } | undefined
  expectParams?: Record<string, unknown> | undefined
  respondAfterSteps?: boolean | undefined
  response?: Record<string, unknown> | undefined
  responseDelayMs?: number | undefined
  steps: FakeAcpStep[]
}

export type FakeCursorScenario = {
  initializeDelayMs?: number | undefined
  initializeExpectParams?: Record<string, unknown> | undefined
  sessionCancel?: {
    error?: { code?: number | undefined; message?: string | undefined } | undefined
    respond?: boolean | undefined
    response?: Record<string, unknown> | undefined
    responseDelayMs?: number | undefined
    steps?: FakeAcpStep[] | undefined
  }
  sessionNew?: {
    expectParams?: Record<string, unknown> | undefined
    response?: Record<string, unknown> | undefined
  }
  sessionPrompt?: SessionPromptDefinition | undefined
  sessionPrompts?: SessionPromptDefinition[] | undefined
  versionOutput?: string | undefined
}

export async function installFakeCursor(root: string, scenario: FakeCursorScenario): Promise<string> {
  const binDir = join(root, "bin")
  await mkdir(binDir, { recursive: true })

  const runnerPath = join(binDir, "fake-cursor.mjs")
  await writeFile(runnerPath, buildRunnerSource(root, scenario), "utf8")

  const wrapperPath = join(binDir, "cursor")
  await writeFile(
    wrapperPath,
    [`#!/bin/sh`, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runnerPath)} "$@"`].join("\n"),
    "utf8",
  )
  await chmod(wrapperPath, 0o755)
  return binDir
}

function buildRunnerSource(root: string, scenario: FakeCursorScenario): string {
  return `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const scenario = ${JSON.stringify(scenario)};
const args = process.argv.slice(2);
const lifecycleLogPath = ${JSON.stringify(join(root, ".fake-cursor-acp-events.log"))};

function appendLifecycleEvent(kind) {
  appendFileSync(lifecycleLogPath, kind + ":" + process.pid + "\\n");
}

if (args[0] === "--version") {
  process.stdout.write((scenario.versionOutput ?? "Cursor 1.0.0") + "\\n");
  process.exit(0);
}

if (args[0] !== "agent" || args[1] !== "acp") {
  process.stderr.write("unsupported fake cursor invocation\\n");
  process.exit(1);
}

let didRecordExit = false;
appendLifecycleEvent("started");
process.on("SIGTERM", () => {
  if (!didRecordExit) {
    didRecordExit = true;
    appendLifecycleEvent("exit");
  }
  process.exit(0);
});
process.on("exit", () => {
  if (didRecordExit) {
    return;
  }
  didRecordExit = true;
  appendLifecycleEvent("exit");
});

let nextSessionId = 1;
let nextRequestId = 1;
const activeSessions = new Map();
const pendingResponses = new Map();

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", async (line) => {
  if (line.trim().length === 0) {
    return;
  }

  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if ((scenario.initializeDelayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, scenario.initializeDelayMs));
    }
    if (scenario.initializeExpectParams !== undefined) {
      assertStableEqual("initialize params", scenario.initializeExpectParams, message.params ?? null);
    }
    respond(message.id, { ok: true });
    return;
  }
  if (message.method === "authenticate") {
    respond(message.id, { ok: true });
    return;
  }
  if (message.method === "session/new") {
    if (scenario.sessionNew?.expectParams !== undefined) {
      assertStableEqual("session/new params", scenario.sessionNew.expectParams, message.params ?? null);
    }
    const sessionId = "session_" + nextSessionId++;
    const context = {
      cwd: message.params.cwd,
      mode: message.params.mode,
      sessionId,
    };
    activeSessions.set(sessionId, context);
    respond(message.id, scenario.sessionNew?.response ?? { sessionId });
    return;
  }
  if (message.method === "session/prompt") {
    const definition = (scenario.sessionPrompts && scenario.sessionPrompts.length > 0)
      ? scenario.sessionPrompts.shift()
      : scenario.sessionPrompt;
    const context = activeSessions.get(message.params.sessionId) ?? {
      cwd: null,
      mode: null,
      sessionId: message.params.sessionId,
    };
    if (definition?.expectParams !== undefined) {
      assertStableEqual("session/prompt params", materialize(definition.expectParams, context), message.params ?? null);
    }
    const respondToPrompt = () => {
      if (definition?.error !== undefined) {
        respondError(message.id, definition.error);
      } else {
        respond(message.id, definition?.response ?? { stopReason: "end_turn" });
      }
    };
    const responseDelayMs = definition?.responseDelayMs ?? 0;
    const dispatchPromptResponse = () => {
      if (responseDelayMs > 0) {
        setTimeout(respondToPrompt, responseDelayMs);
      } else {
        respondToPrompt();
      }
    };
    if (definition?.respondAfterSteps === false) {
      dispatchPromptResponse();
    }
    const launch = () => {
      playSteps(definition?.steps ?? [], context)
        .then(() => {
          if (definition?.respondAfterSteps !== false) {
            dispatchPromptResponse();
          }
        })
        .catch(fail);
    };
    if (definition?.dispatch === "immediate") {
      launch();
    } else {
      setTimeout(launch, 0);
    }
    return;
  }
  if (message.method === "session/cancel") {
    const response = scenario.sessionCancel?.response ?? { cancelled: true };
    const error = scenario.sessionCancel?.error;
    const respondToCancel = scenario.sessionCancel?.respond ?? true;
    const responseDelayMs = scenario.sessionCancel?.responseDelayMs ?? 0;
    if (respondToCancel) {
      if (responseDelayMs > 0) {
        setTimeout(() => {
          if (error !== undefined) {
            respondError(message.id, error);
            return;
          }
          respond(message.id, response);
        }, responseDelayMs);
      } else {
        if (error !== undefined) {
          respondError(message.id, error);
        } else {
          respond(message.id, response);
        }
      }
    }
    const context = activeSessions.get(message.params.sessionId) ?? {
      cwd: null,
      mode: null,
      sessionId: message.params.sessionId,
    };
    setTimeout(() => {
      playSteps(
        scenario.sessionCancel?.steps ?? [],
        context,
      ).catch(fail);
    }, 0);
    return;
  }
  if ("id" in message) {
    pendingResponses.set(String(message.id), message.result ?? null);
  }
});

async function playSteps(steps, context) {
  for (const step of steps) {
    if (step.kind === "delay") {
      await new Promise((resolve) => setTimeout(resolve, step.ms));
      continue;
    }
    if (step.kind === "notification") {
      notify(step.method, materialize(step.params ?? {}, context));
      continue;
    }
    if (step.kind === "stderr") {
      process.stderr.write(materialize(step.text, context) + "\\n");
      continue;
    }
    if (step.kind === "stdout") {
      process.stdout.write(materialize(step.text, context) + "\\n");
      continue;
    }

    const requestId = step.requestId ?? "server_req_" + nextRequestId++;
    request(step.method, requestId, materialize(step.params ?? {}, context));
    const response = await waitForResponse(String(requestId));
    if (step.expectResult !== undefined) {
      assertStableEqual("client response for " + step.method, materialize(step.expectResult, context), response);
    }
  }
}

function materialize(value, context) {
  if (Array.isArray(value)) {
    return value.map((item) => materialize(item, context));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item, context)]));
  }
  if (value === "__SESSION_ID__") {
    return context.sessionId;
  }
  if (value === "__MODE__") {
    return context.mode;
  }
  if (value === "__CWD__") {
    return context.cwd;
  }
  return value;
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
}

function respondError(id, error) {
  process.stdout.write(JSON.stringify({ id, error }) + "\\n");
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ method, params }) + "\\n");
}

function request(method, id, params) {
  process.stdout.write(JSON.stringify({ method, id, params }) + "\\n");
}

async function waitForResponse(id) {
  while (!pendingResponses.has(id)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const value = pendingResponses.get(id);
  pendingResponses.delete(id);
  return value;
}

function assertStableEqual(label, expectedValue, actualValue) {
  const expected = stableStringify(expectedValue);
  const actual = stableStringify(actualValue);
  if (expected !== actual) {
    throw new Error("unexpected " + label + ": " + actual + " !== " + expected);
  }
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

function fail(error) {
  const message = String(error.stack ?? error);
  writeFileSync(${JSON.stringify(join("/tmp", "rigg-fake-cursor-error.log"))}, message + "\\n");
  process.stderr.write(message + "\\n");
  process.exit(1);
}
`
}
