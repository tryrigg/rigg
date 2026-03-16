import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

type FakeRpcStep =
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

export type FakeCodexScenario = {
  accountReadResult?: Record<string, unknown> | undefined
  accountReadDelayMs?: number | undefined
  collaborationModeListResult?:
    | {
        data: Array<{
          mode?: string | null | undefined
          model?: string | null | undefined
          name: string
          reasoning_effort?: string | null | undefined
        }>
      }
    | undefined
  initializeExpectParams?: Record<string, unknown> | undefined
  initializeDelayMs?: number | undefined
  reviewStart?: {
    dispatch?: "deferred" | "immediate" | undefined
    response?: Record<string, unknown> | undefined
    steps: FakeRpcStep[]
  }
  reviewStarts?:
    | Array<{
        dispatch?: "deferred" | "immediate" | undefined
        response?: Record<string, unknown> | undefined
        steps: FakeRpcStep[]
      }>
    | undefined
  turnInterrupt?: {
    respond?: boolean | undefined
    response?: Record<string, unknown> | undefined
    responseDelayMs?: number | undefined
    steps?: FakeRpcStep[] | undefined
  }
  turnStart?: {
    dispatch?: "deferred" | "immediate" | undefined
    expectParams?: Record<string, unknown> | undefined
    response?: Record<string, unknown> | undefined
    steps: FakeRpcStep[]
  }
  turnStarts?:
    | Array<{
        dispatch?: "deferred" | "immediate" | undefined
        expectParams?: Record<string, unknown> | undefined
        response?: Record<string, unknown> | undefined
        steps: FakeRpcStep[]
      }>
    | undefined
  threadStartDelayMs?: number | undefined
  threadStartExpectParams?: Record<string, unknown> | undefined
  versionOutput?: string | undefined
}

export async function installFakeCodex(root: string, scenario: FakeCodexScenario): Promise<string> {
  const binDir = join(root, "bin")
  await mkdir(binDir, { recursive: true })

  const runnerPath = join(binDir, "fake-codex.mjs")
  await writeFile(runnerPath, buildRunnerSource(root, scenario), "utf8")

  const wrapperPath = join(binDir, "codex")
  await writeFile(
    wrapperPath,
    [`#!/bin/sh`, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runnerPath)} "$@"`].join("\n"),
    "utf8",
  )
  await chmod(wrapperPath, 0o755)
  return binDir
}

function buildRunnerSource(root: string, scenario: FakeCodexScenario): string {
  return `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const scenario = ${JSON.stringify(scenario)};
const args = process.argv.slice(2);
const lifecycleLogPath = ${JSON.stringify(join(root, ".fake-codex-app-server-events.log"))};

function appendLifecycleEvent(kind) {
  appendFileSync(lifecycleLogPath, kind + ":" + process.pid + "\\n");
}

if (args[0] === "--version") {
  process.stdout.write((scenario.versionOutput ?? "codex-cli 0.114.0") + "\\n");
  process.exit(0);
}

if (args[0] !== "app-server") {
  process.stderr.write("unsupported fake codex invocation\\n");
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

let nextThreadId = 1;
let nextTurnId = 1;
let nextRequestId = 1;
const activeTurns = new Map();

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
      const expected = stableStringify(scenario.initializeExpectParams);
      const actual = stableStringify(message.params ?? null);
      if (expected !== actual) {
        throw new Error("unexpected initialize params: " + actual + " !== " + expected);
      }
    }
    respond(message.id, { userAgent: "fake-codex/0.0.0 rigg-test/0.0.0" });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "account/read") {
    if ((scenario.accountReadDelayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, scenario.accountReadDelayMs));
    }
    respond(
      message.id,
      scenario.accountReadResult ?? { account: { type: "apiKey" }, requiresOpenaiAuth: false },
    );
    return;
  }
  if (message.method === "thread/start") {
    if ((scenario.threadStartDelayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, scenario.threadStartDelayMs));
    }
    if (scenario.threadStartExpectParams !== undefined) {
      const expected = stableStringify(scenario.threadStartExpectParams);
      const actual = stableStringify(message.params ?? null);
      if (expected !== actual) {
        throw new Error("unexpected thread/start params: " + actual + " !== " + expected);
      }
    }
    const threadId = "thread_" + nextThreadId++;
    respond(message.id, { thread: { id: threadId } });
    notify("thread/started", { thread: { id: threadId } });
    return;
  }
  if (message.method === "collaborationMode/list") {
    respond(message.id, scenario.collaborationModeListResult ?? {
      data: [
        { name: "Plan", mode: "plan", model: "gpt-5.4", reasoning_effort: "medium" },
        { name: "Default", mode: "default", model: "gpt-5.4", reasoning_effort: null },
      ],
    });
    return;
  }
  if (message.method === "turn/start") {
    const definition = (scenario.turnStarts && scenario.turnStarts.length > 0)
      ? scenario.turnStarts.shift()
      : scenario.turnStart;
    const turnId = "turn_" + nextTurnId++;
    const context = { kind: "turn", threadId: message.params.threadId, turnId };
    if (definition?.expectParams !== undefined) {
      const expected = stableStringify(materialize(definition.expectParams, context));
      const actual = stableStringify(message.params ?? null);
      if (expected !== actual) {
        throw new Error("unexpected turn/start params: " + actual + " !== " + expected);
      }
    }
    activeTurns.set(turnId, context);
    respond(message.id, definition?.response ?? { turn: { id: turnId, items: [], status: "inProgress", error: null } });
    const launch = () => {
      playSteps(definition?.steps ?? [], context).catch(fail);
    };
    if (definition?.dispatch === "immediate") {
      launch();
    } else {
      setTimeout(launch, 0);
    }
    return;
  }
  if (message.method === "review/start") {
    const definition = (scenario.reviewStarts && scenario.reviewStarts.length > 0)
      ? scenario.reviewStarts.shift()
      : scenario.reviewStart;
    const turnId = "review_" + nextTurnId++;
    const context = { kind: "review", threadId: message.params.threadId, turnId };
    activeTurns.set(turnId, context);
    respond(
      message.id,
      definition?.response ?? {
        turn: { id: turnId, items: [], status: "inProgress", error: null },
        reviewThreadId: message.params.threadId,
      },
    );
    const launch = () => {
      playSteps(definition?.steps ?? [], context).catch(fail);
    };
    if (definition?.dispatch === "immediate") {
      launch();
    } else {
      setTimeout(launch, 0);
    }
    return;
  }
  if (message.method === "turn/interrupt") {
    const interruptResponse = scenario.turnInterrupt?.response ?? {};
    const respondToInterrupt = scenario.turnInterrupt?.respond ?? true;
    const responseDelayMs = scenario.turnInterrupt?.responseDelayMs ?? 0;
    if (respondToInterrupt) {
      if (responseDelayMs > 0) {
        setTimeout(() => {
          respond(message.id, interruptResponse);
        }, responseDelayMs);
      } else {
        respond(message.id, interruptResponse);
      }
    }
    const interruptedTurn = activeTurns.get(message.params.turnId) ?? { threadId: message.params.threadId, turnId: message.params.turnId };
    setTimeout(() => {
      playSteps(
        scenario.turnInterrupt?.steps ?? [
          {
            kind: "notification",
            method: "turn/completed",
            params: {
              threadId: interruptedTurn.threadId,
              turn: {
                id: interruptedTurn.turnId,
                items: [],
                status: "interrupted",
                error: null,
              },
            },
          },
        ],
        interruptedTurn,
      )
        .then(() => {
          activeTurns.delete(interruptedTurn.turnId);
        })
        .catch(fail);
    }, 0);
    return;
  }
  if ("id" in message) {
    pendingResponses.set(String(message.id), message.result ?? null);
  }
});

const pendingResponses = new Map();

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
      const expected = stableStringify(materialize(step.expectResult, context));
      const actual = stableStringify(response);
      if (expected !== actual) {
        throw new Error("unexpected client response for " + step.method + ": " + actual + " !== " + expected);
      }
    }
  }
  activeTurns.delete(context.turnId);
}

function materialize(value, context) {
  if (Array.isArray(value)) {
    return value.map((item) => materialize(item, context));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item, context)]));
  }
  if (value === "__THREAD_ID__") {
    return context.threadId;
  }
  if (value === "__TURN_ID__") {
    return context.turnId;
  }
  return value;
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
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
  writeFileSync(${JSON.stringify(join("/tmp", "rigg-fake-codex-error.log"))}, message + "\\n");
  process.stderr.write(message + "\\n");
  process.exit(1);
}
`
}
