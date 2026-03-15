import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

type FakeRpcStep =
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

export type FakeCodexScenario = {
  accountReadResult?: Record<string, unknown> | undefined
  reviewStart?: {
    response?: Record<string, unknown> | undefined
    steps: FakeRpcStep[]
  }
  turnInterrupt?: {
    response?: Record<string, unknown> | undefined
    steps?: FakeRpcStep[] | undefined
  }
  turnStart?: {
    response?: Record<string, unknown> | undefined
    steps: FakeRpcStep[]
  }
  versionOutput?: string | undefined
}

export async function installFakeCodex(root: string, scenario: FakeCodexScenario): Promise<string> {
  const binDir = join(root, "bin")
  await mkdir(binDir, { recursive: true })

  const runnerPath = join(binDir, "fake-codex.mjs")
  await writeFile(runnerPath, buildRunnerSource(scenario), "utf8")

  const wrapperPath = join(binDir, "codex")
  await writeFile(
    wrapperPath,
    [`#!/bin/sh`, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runnerPath)} "$@"`].join("\n"),
    "utf8",
  )
  await chmod(wrapperPath, 0o755)
  return binDir
}

function buildRunnerSource(scenario: FakeCodexScenario): string {
  return `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import readline from "node:readline";

const scenario = ${JSON.stringify(scenario)};
const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write((scenario.versionOutput ?? "codex-cli 0.114.0") + "\\n");
  process.exit(0);
}

if (args[0] !== "app-server") {
  process.stderr.write("unsupported fake codex invocation\\n");
  process.exit(1);
}

let nextThreadId = 1;
let nextTurnId = 1;
let nextRequestId = 1;
let activeTurn = null;

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
    respond(message.id, { userAgent: "fake-codex/0.0.0 rigg-test/0.0.0" });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "account/read") {
    respond(
      message.id,
      scenario.accountReadResult ?? { account: { type: "apiKey" }, requiresOpenaiAuth: false },
    );
    return;
  }
  if (message.method === "thread/start") {
    const threadId = "thread_" + nextThreadId++;
    respond(message.id, { thread: { id: threadId } });
    notify("thread/started", { thread: { id: threadId } });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = "turn_" + nextTurnId++;
    activeTurn = { kind: "turn", threadId: message.params.threadId, turnId };
    respond(message.id, scenario.turnStart?.response ?? { turn: { id: turnId, items: [], status: "inProgress", error: null } });
    setTimeout(() => {
      playSteps(scenario.turnStart?.steps ?? [], activeTurn).catch(fail);
    }, 0);
    return;
  }
  if (message.method === "review/start") {
    const turnId = "review_" + nextTurnId++;
    activeTurn = { kind: "review", threadId: message.params.threadId, turnId };
    respond(
      message.id,
      scenario.reviewStart?.response ?? {
        turn: { id: turnId, items: [], status: "inProgress", error: null },
        reviewThreadId: message.params.threadId,
      },
    );
    setTimeout(() => {
      playSteps(scenario.reviewStart?.steps ?? [], activeTurn).catch(fail);
    }, 0);
    return;
  }
  if (message.method === "turn/interrupt") {
    respond(message.id, scenario.turnInterrupt?.response ?? {});
    setTimeout(() => {
      playSteps(
        scenario.turnInterrupt?.steps ?? [
          {
            kind: "notification",
            method: "turn/completed",
            params: {
              threadId: activeTurn?.threadId ?? message.params.threadId,
              turn: {
                id: activeTurn?.turnId ?? message.params.turnId,
                items: [],
                status: "interrupted",
                error: null,
              },
            },
          },
        ],
        activeTurn ?? { threadId: message.params.threadId, turnId: message.params.turnId },
      )
        .then(() => {
          activeTurn = null;
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
    if (step.kind === "notification") {
      notify(step.method, materialize(step.params ?? {}, context));
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
