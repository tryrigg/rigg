import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runActionStep } from "../../src/run/adapters"
import type { ActionNode } from "../../src/compile/schema"
import { renderContext } from "../fixture/builders"

describe("run/adapters", () => {
  test("runs shell steps with cwd and env", async () => {
    const outputChunks: Array<{ chunk: string; stream: "stderr" | "stdout" }> = []
    const step: ActionNode = {
      type: "shell",
      with: {
        command: "echo $RIGG_TEST_VALUE && pwd",
        result: "text",
      },
    }

    const result = await runActionStep(step, renderContext(), {
      artifactsDir: process.cwd(),
      cwd: process.cwd(),
      env: { ...process.env, RIGG_TEST_VALUE: "hello" },
      onOutput: (stream, chunk) => {
        outputChunks.push({ chunk, stream })
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("hello")
    expect(result.stdout).toContain(process.cwd())
    expect(outputChunks.every((chunk) => chunk.stream === "stdout")).toBe(true)
    expect(outputChunks.map((chunk) => chunk.chunk).join("")).toBe(result.stdout)
  })

  test("streams shell stdout chunks before process exit", async () => {
    let resolveFirstChunk: (() => void) | undefined
    const firstChunk = new Promise<void>((resolve) => {
      resolveFirstChunk = resolve
    })

    const execution = runActionStep(
      {
        type: "shell",
        with: {
          command: "printf first; sleep 0.2; printf second",
          result: "text",
        },
      },
      renderContext(),
      {
        artifactsDir: process.cwd(),
        cwd: process.cwd(),
        env: process.env,
        onOutput: (stream, chunk) => {
          if (stream === "stdout" && chunk.includes("first")) {
            resolveFirstChunk?.()
          }
        },
      },
    )

    await Promise.race([
      firstChunk,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("expected streamed shell output")), 150)),
    ])

    await expect(execution).resolves.toMatchObject({
      exitCode: 0,
      stdout: "firstsecond",
    })
  })

  test("does not parse shell json output before checking process failure", async () => {
    const step: ActionNode = {
      type: "shell",
      with: {
        command: "printf 'not-json'; exit 7",
        result: "json",
      },
    }

    const result = await runActionStep(step, renderContext(), {
      artifactsDir: process.cwd(),
      cwd: process.cwd(),
      env: process.env,
    })

    expect(result.exitCode).toBe(7)
    expect(result.result).toBeNull()
    expect(result.stdout).toBe("not-json")
  })

  test("fails shell json result formatting only after a successful process exit", async () => {
    await expect(
      runActionStep(
        {
          type: "shell",
          with: {
            command: "printf 'not-json'",
            result: "json",
          },
        },
        renderContext(),
        {
          artifactsDir: process.cwd(),
          cwd: process.cwd(),
          env: process.env,
        },
      ),
    ).rejects.toThrow("Shell step returned invalid JSON")
  })

  test("writes relative files against the provided cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-write-file-"))
    try {
      const step: ActionNode = {
        type: "write_file",
        with: {
          content: "hello",
          path: "nested/output.txt",
        },
      }

      const result = await runActionStep(step, renderContext(), {
        artifactsDir: root,
        cwd: root,
        env: process.env,
      })

      expect(result.result).toEqual({ path: join(root, "nested/output.txt") })
      expect(await readFile(join(root, "nested/output.txt"), "utf8")).toBe("hello")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("parses provider events and validates codex review output", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-review-"))
    const binDir = join(root, "bin")
    await mkdir(binDir, { recursive: true })
    const toolPath = join(binDir, "codex")
    await writeFile(
      toolPath,
      [
        "#!/bin/sh",
        'printf \'%s\\n\' \'{"type":"thread.started","thread_id":"thread_123"}\'',
        'printf \'%s\\n\' \'{"tool":"read_file","payload":{"path":"src/main.ts"}}\'',
        'printf \'%s\\n\' \'{"type":"agent_message_delta","delta":{"text":"Reviewing diff..."}}\'',
        'printf \'%s\\n\' \'{"type":"exited_review_mode","review_output":{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"looks good","overall_confidence_score":0.91}}\'',
      ].join("\n"),
      "utf8",
    )
    await chmod(toolPath, 0o755)

    try {
      const events: Array<Record<string, unknown>> = []
      const result = await runActionStep(
        {
          type: "codex",
          with: {
            action: "review",
            target: "uncommitted",
          },
        },
        renderContext(),
        {
          artifactsDir: root,
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          onProviderEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>)
          },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.result).toEqual({
        findings: [],
        overall_confidence_score: 0.91,
        overall_correctness: "patch is correct",
        overall_explanation: "looks good",
      })
      expect(events).toEqual([
        { kind: "status", message: "thread started thread_123", provider: "codex" },
        { detail: "path=src/main.ts", kind: "tool_use", provider: "codex", tool: "read_file" },
        { kind: "status", message: "Reviewing diff...", provider: "codex" },
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("rejects malformed codex review payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-review-invalid-"))
    const binDir = join(root, "bin")
    await mkdir(binDir, { recursive: true })
    const toolPath = join(binDir, "codex")
    await writeFile(
      toolPath,
      ["#!/bin/sh", 'printf \'%s\\n\' \'{"type":"exited_review_mode","review_output":{"findings":[]}}\''].join("\n"),
      "utf8",
    )
    await chmod(toolPath, 0o755)

    try {
      await expect(
        runActionStep(
          {
            type: "codex",
            with: {
              action: "review",
              target: "uncommitted",
            },
          },
          renderContext(),
          {
            artifactsDir: root,
            cwd: root,
            env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          },
        ),
      ).rejects.toThrow("result.overall_correctness is required")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
