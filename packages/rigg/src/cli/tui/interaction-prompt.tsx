import { Box, Text, useInput } from "ink"
import TextInput from "ink-text-input"
import { useMemo, useState } from "react"

import type {
  CodexApprovalDecision,
  CodexInteractionRequest,
  CodexInteractionResolution,
} from "../../codex/interaction"
import type { PendingInteraction } from "../../run/schema"
import { stringifyJsonCompact, tryParseJson } from "../../util/json"
import { Divider } from "./divider"
import { matchesShortcut } from "./input"

function approvalShortcut(decision: CodexApprovalDecision, index: number): string {
  switch (decision.intent) {
    case "approve":
      return "y"
    case "deny":
      return "n"
    case "cancel":
      return "c"
    case null:
      return String(index + 1)
  }
}

export type ApprovalPromptChoice = {
  decision: string
  shortcut: string
  tokens: string[]
}

function normalizeApprovalChoiceInput(input: string): string {
  return input.trim().toLowerCase()
}

export function buildApprovalPromptChoices(decisions: ReadonlyArray<CodexApprovalDecision>): ApprovalPromptChoice[] {
  const choices: ApprovalPromptChoice[] = []
  for (const [index, decision] of decisions.entries()) {
    const tokens = new Set<string>()
    const normalizedValue = normalizeApprovalChoiceInput(decision.value)
    if (normalizedValue.length > 0) {
      tokens.add(normalizedValue)
    }
    tokens.add(String(index + 1))
    tokens.add(approvalShortcut(decision, index))
    choices.push({
      decision: decision.value,
      shortcut: approvalShortcut(decision, index),
      tokens: [...tokens],
    })
  }
  return choices
}

export function resolveApprovalChoice(choices: ReadonlyArray<ApprovalPromptChoice>, input: string): string | undefined {
  const normalized = normalizeApprovalChoiceInput(input)
  if (normalized.length === 0) {
    return undefined
  }

  for (const choice of choices) {
    if (choice.tokens.includes(normalized)) {
      return choice.decision
    }
  }

  return undefined
}

export function shouldAutoSubmitApprovalChoice(choices: ReadonlyArray<ApprovalPromptChoice>, input: string): boolean {
  const normalized = normalizeApprovalChoiceInput(input)
  if (normalized.length === 0 || resolveApprovalChoice(choices, normalized) === undefined) {
    return false
  }

  for (const choice of choices) {
    for (const token of choice.tokens) {
      if (token.length > normalized.length && token.startsWith(normalized)) {
        return false
      }
    }
  }

  return true
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

function ApprovalPrompt({
  request,
  onResolve,
}: {
  request: Extract<CodexInteractionRequest, { kind: "approval" }>
  onResolve: (resolution: CodexInteractionResolution) => void
}) {
  const choices = useMemo(() => buildApprovalPromptChoices(request.decisions), [request.decisions])
  const [inputValue, setInputValue] = useState("")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const submitChoice = (value: string): boolean => {
    const decision = resolveApprovalChoice(choices, value)
    if (decision === undefined) {
      return false
    }
    onResolve({ decision, kind: "approval" })
    return true
  }

  const handleChange = (value: string) => {
    setInputValue(value)
    setErrorMessage(null)
    if (shouldAutoSubmitApprovalChoice(choices, value)) {
      submitChoice(value)
    }
  }

  const handleSubmit = (value: string) => {
    if (submitChoice(value)) {
      return
    }
    setErrorMessage("Unknown choice. Type a shortcut, number, or exact decision label.")
  }

  return (
    <Box flexDirection="column">
      <Divider label="Approval Required" color="cyan" />
      <Text>
        {"  "}
        <Text bold>{request.requestKind}</Text>: {request.command ?? request.message}
      </Text>
      <Text dimColor>
        {"  "}reason: {request.message}
      </Text>
      {request.cwd && (
        <Text dimColor>
          {"  "}cwd: {request.cwd}
        </Text>
      )}
      <Text />
      <Text>
        {"  "}
        {choices.map((choice) => {
          return (
            <Text key={choice.decision}>
              <Text bold color="cyan">
                [{choice.shortcut}]
              </Text>
              {choice.decision}
              {"  "}
            </Text>
          )
        })}
      </Text>
      <Box marginTop={1}>
        <Text>
          {"  "}
          {">"}{" "}
        </Text>
        <TextInput value={inputValue} onChange={handleChange} onSubmit={handleSubmit} />
      </Box>
      {errorMessage !== null && (
        <Text color="red">
          {"  "}
          {errorMessage}
        </Text>
      )}
    </Box>
  )
}

function UserInputPrompt({
  request,
  onResolve,
}: {
  request: Extract<CodexInteractionRequest, { kind: "user_input" }>
  onResolve: (resolution: CodexInteractionResolution) => void
}) {
  const [questionIndex, setQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, { answers: string[] }>>({})
  const [inputValue, setInputValue] = useState("")

  const question = request.questions[questionIndex]
  if (question === undefined) {
    return null
  }

  const total = request.questions.length

  const handleSubmit = (value: string) => {
    if (value.trim().length === 0) {
      return
    }
    const normalized = normalizeQuestionAnswer(value.trim(), question.options)
    const newAnswers = { ...answers, [question.id]: { answers: [normalized] } }

    if (questionIndex + 1 >= total) {
      onResolve({ answers: newAnswers, kind: "user_input" })
    } else {
      setAnswers(newAnswers)
      setQuestionIndex(questionIndex + 1)
      setInputValue("")
    }
  }

  return (
    <Box flexDirection="column">
      <Divider label="Input Required" color="cyan" />
      <Text>
        {"  "}
        {total > 1 ? `Question ${questionIndex + 1}/${total}: ` : ""}
        <Text bold>{question.header}</Text>
      </Text>
      <Text>
        {"  "}
        {question.question}
      </Text>
      {question.options !== null && question.options.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {question.options.map((option, i) => (
            <Text key={option.label}>
              {"  "}
              {i + 1}. {option.label}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          {"  "}
          {">"}{" "}
        </Text>
        <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
      </Box>
    </Box>
  )
}

function ElicitationPrompt({
  request,
  onResolve,
}: {
  request: Extract<CodexInteractionRequest, { kind: "elicitation" }>
  onResolve: (resolution: CodexInteractionResolution) => void
}) {
  const [phase, setPhase] = useState<"choose" | "json">("choose")
  const [jsonInput, setJsonInput] = useState("")

  useInput(
    (input, key) => {
      if (matchesShortcut(input, key, "a")) {
        if (request.mode === "url") {
          onResolve({ action: "accept", kind: "elicitation" })
        } else {
          setPhase("json")
        }
      } else if (matchesShortcut(input, key, "d")) {
        onResolve({ action: "decline", kind: "elicitation" })
      } else if (matchesShortcut(input, key, "c")) {
        onResolve({ action: "cancel", kind: "elicitation" })
      }
    },
    { isActive: phase === "choose" },
  )

  const handleJsonSubmit = (value: string) => {
    const parsed = tryParseJson(value)
    if (parsed !== undefined) {
      onResolve({ action: "accept", content: parsed, kind: "elicitation" })
    }
  }

  return (
    <Box flexDirection="column">
      <Divider label="External Request" color="cyan" />
      <Text>
        {"  "}
        <Text bold>{request.message}</Text>
      </Text>
      {request.mode === "url" ? (
        <Text dimColor>
          {"  "}url: {request.url}
        </Text>
      ) : (
        <Text dimColor>
          {"  "}schema: {stringifyJsonCompact(request.requestedSchema ?? {})}
        </Text>
      )}
      <Text />
      {phase === "choose" ? (
        <Text>
          {"  "}
          <Text bold color="cyan">
            [a]
          </Text>{" "}
          accept{"  "}
          <Text bold color="red">
            [d]
          </Text>{" "}
          deny{"  "}
          <Text bold dimColor>
            [c]
          </Text>{" "}
          cancel
        </Text>
      ) : (
        <Box>
          <Text>{"  "}JSON: </Text>
          <TextInput value={jsonInput} onChange={setJsonInput} onSubmit={handleJsonSubmit} />
        </Box>
      )}
    </Box>
  )
}

export function InteractionPrompt({
  interaction,
  onResolve,
}: {
  interaction: PendingInteraction
  onResolve: (resolution: CodexInteractionResolution) => void
}) {
  switch (interaction.request.kind) {
    case "approval":
      return <ApprovalPrompt request={interaction.request} onResolve={onResolve} />
    case "user_input":
      return <UserInputPrompt request={interaction.request} onResolve={onResolve} />
    case "elicitation":
      return <ElicitationPrompt request={interaction.request} onResolve={onResolve} />
  }
}
