import { createInterface } from "node:readline/promises"

import type { CodexProviderEvent } from "../codex/event"
import type { CodexInteractionRequest } from "../codex/interaction"
import type { RunControlHandler, RunEvent } from "../run/progress"

export type TerminalRunSession = {
  close: () => void
  emit: (event: RunEvent) => void
  handle: RunControlHandler
}

export function createTerminalRunSession(input: NodeJS.ReadStream, output: NodeJS.WriteStream): TerminalRunSession {
  const readline = createInterface({
    input,
    output,
    terminal: Boolean(output.isTTY),
  })

  function emit(event: RunEvent): void {
    switch (event.kind) {
      case "provider_event":
        output.write(formatProviderEvent(event.user_id ?? event.node_path, event.event))
        return
      case "node_completed":
        output.write(`step ${event.node.user_id ?? event.node.node_path} ${event.node.status}\n`)
        return
      case "run_finished":
        output.write(`run ${event.snapshot.status}`)
        if (event.snapshot.reason !== null) {
          output.write(` (${event.snapshot.reason})`)
        }
        output.write("\n")
        return
      default:
        return
    }
  }

  async function handle(request: Parameters<RunControlHandler>[0]) {
    if (request.kind === "step_barrier") {
      output.write("\n[next]\n")
      if (request.barrier.completed != null) {
        output.write(
          `completed: ${request.barrier.completed.user_id ?? request.barrier.completed.node_path} (${request.barrier.completed.status})\n`,
        )
      }
      for (const next of request.barrier.next) {
        output.write(`- ${next.user_id ?? next.node_path} [${next.node_kind}]`)
        if (next.detail !== null && next.detail !== undefined && next.detail.length > 0) {
          output.write(` ${next.detail}`)
        }
        if (next.action) {
          output.write(` action=${next.action}`)
        }
        if (next.model) {
          output.write(` model=${next.model}`)
        }
        if (next.cwd) {
          output.write(` cwd=${next.cwd}`)
        }
        output.write("\n")
        if (next.prompt_preview) {
          output.write(`  preview: ${next.prompt_preview}\n`)
        }
      }
      return {
        action: await promptChoice(readline, "Continue? [c]ontinue / [a]bort: ", {
          a: "abort",
          c: "continue",
        }),
        kind: "step_barrier" as const,
      }
    }

    return await handleInteraction(readline, output, request.interaction.request as CodexInteractionRequest)
  }

  return {
    close: () => readline.close(),
    emit,
    handle,
  }
}

async function handleInteraction(
  readline: ReturnType<typeof createInterface>,
  output: NodeJS.WriteStream,
  request: CodexInteractionRequest,
) {
  switch (request.kind) {
    case "approval":
      output.write(`\n[approval] ${request.message}\n`)
      if (request.command) {
        output.write(`command: ${request.command}\n`)
      }
      if (request.cwd) {
        output.write(`cwd: ${request.cwd}\n`)
      }
      return {
        decision: await promptChoice(readline, "Approve? [y]es / [n]o / [c]ancel: ", {
          c: "cancel",
          n: "decline",
          y: "accept",
        }),
        kind: "approval" as const,
      }

    case "user_input": {
      output.write("\n[user input]\n")
      const answers: Record<string, { answers: string[] }> = {}
      for (const question of request.questions) {
        output.write(`${question.header}: ${question.question}\n`)
        if (question.options !== null) {
          question.options.forEach((option, index) => {
            output.write(`${index + 1}. ${option.label} - ${option.description}\n`)
          })
        }
        const answer = await promptLine(readline, "> ")
        answers[question.id] = {
          answers: [normalizeQuestionAnswer(answer, question.options)],
        }
      }
      return { answers, kind: "user_input" as const }
    }

    case "elicitation": {
      output.write(`\n[elicitation] ${request.message}\n`)
      if (request.mode === "url") {
        output.write(`url: ${request.url}\n`)
        return {
          action: await promptChoice(readline, "Respond? [a]ccept / [d]ecline / [c]ancel: ", {
            a: "accept",
            c: "cancel",
            d: "decline",
          }),
          kind: "elicitation" as const,
        }
      }

      output.write(`schema: ${JSON.stringify(request.requestedSchema)}\n`)
      const action = await promptChoice(readline, "Respond? [a]ccept / [d]ecline / [c]ancel: ", {
        a: "accept",
        c: "cancel",
        d: "decline",
      })
      if (action !== "accept") {
        return { action, kind: "elicitation" as const }
      }

      const content = await promptJson(readline, "JSON response: ")
      return {
        action,
        content,
        kind: "elicitation" as const,
      }
    }
  }
}

async function promptChoice<TChoice extends string>(
  readline: ReturnType<typeof createInterface>,
  prompt: string,
  map: Record<string, TChoice>,
): Promise<TChoice> {
  while (true) {
    const raw = (await readline.question(prompt)).trim().toLowerCase()
    const choice = map[raw]
    if (choice !== undefined) {
      return choice
    }
  }
}

async function promptLine(readline: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  while (true) {
    const value = (await readline.question(prompt)).trim()
    if (value.length > 0) {
      return value
    }
  }
}

function normalizeQuestionAnswer(
  answer: string,
  options: ReadonlyArray<{ description: string; label: string }> | null,
): string {
  if (options === null) {
    return answer
  }

  const index = Number.parseInt(answer, 10)
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1]?.label ?? answer
  }

  return answer
}

async function promptJson(readline: ReturnType<typeof createInterface>, prompt: string): Promise<unknown> {
  while (true) {
    const value = await promptLine(readline, prompt)
    try {
      return JSON.parse(value)
    } catch {}
  }
}

function formatProviderEvent(nodeId: string, event: CodexProviderEvent): string {
  switch (event.kind) {
    case "thread_started":
      return `${nodeId}: thread ${event.threadId} started\n`
    case "turn_started":
      return `${nodeId}: turn ${event.turnId} started\n`
    case "turn_completed":
      return `${nodeId}: turn ${event.turnId} ${event.status}\n`
    case "message_delta":
      return `${nodeId}: ${event.text}\n`
    case "message_completed":
      return `${nodeId}: ${event.text}\n`
    case "tool_started":
      return `tool ${nodeId}: ${event.tool}${event.detail ? ` ${event.detail}` : ""}\n`
    case "tool_completed":
      return `tool ${nodeId}: ${event.tool} completed${event.detail ? ` ${event.detail}` : ""}\n`
    case "error":
      return `${nodeId}: ${event.message}\n`
    case "diagnostic":
      return `${nodeId}: ${event.message}\n`
  }
}
