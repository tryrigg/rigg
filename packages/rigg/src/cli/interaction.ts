import { createInterface } from "node:readline/promises"

import type { CodexInteractionHandler, CodexInteractionRequest } from "../codex/types"

export type TerminalInteractionSession = {
  close: () => void
  handle: CodexInteractionHandler
}

export function createTerminalInteractionSession(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): TerminalInteractionSession {
  const readline = createInterface({
    input,
    output,
    terminal: Boolean(output.isTTY),
  })

  async function handle(request: CodexInteractionRequest) {
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

  return {
    close: () => readline.close(),
    handle,
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
