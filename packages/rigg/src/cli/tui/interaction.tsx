import { Box, Text, useInput } from "ink"
import { useMemo, useState } from "react"

import type {
  ApprovalDecision,
  InteractionRequest,
  InteractionResolution,
  UserInputQuestion,
} from "../../session/interaction"
import type { PendingInteraction } from "../../session/schema"
import { compactJson, safeParseJson } from "../../util/json"
import { matchesShortcut } from "./input"
import { PromptTextInput } from "./prompt"
import { chars } from "./theme"

function approvalShortcut(decision: ApprovalDecision, index: number): string {
  if (decision.shortcut) {
    return normalizeApprovalChoiceInput(decision.shortcut)
  }

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

function shortcutCandidates(decision: ApprovalDecision, index: number): string[] {
  const words = approvalSearchText(decision)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
  const compactValue = approvalSearchText(decision).replace(/[^a-z0-9]+/g, "")
  const candidates = new Set<string>([approvalShortcut(decision, index)])

  for (const word of words) {
    candidates.add(word[0]!)
  }
  for (const char of compactValue) {
    candidates.add(char)
  }
  candidates.add(String(index + 1))

  return [...candidates]
}

export type PromptChoice = {
  completionTokens: string[]
  decision: string
  intent: ApprovalDecision["intent"]
  indexToken: string
  shortcut: string
  tokens: string[]
}

function normalizeApprovalChoiceInput(input: string): string {
  return input.trim().toLowerCase()
}

function approvalLabel(decision: ApprovalDecision): string {
  return decision.label ?? decision.value
}

function approvalSearchText(decision: ApprovalDecision): string {
  return normalizeApprovalChoiceInput(`${approvalLabel(decision)} ${decision.value}`)
}

export function buildChoices(decisions: ReadonlyArray<ApprovalDecision>): PromptChoice[] {
  const choices: PromptChoice[] = []
  const usedShortcuts = new Set<string>()
  for (const [index, decision] of decisions.entries()) {
    const tokens = new Set<string>()
    const completionTokens = new Set<string>()
    const indexToken = String(index + 1)
    const normalizedLabel = normalizeApprovalChoiceInput(approvalLabel(decision))
    const shortcut =
      shortcutCandidates(decision, index).find((candidate) => !usedShortcuts.has(candidate)) ?? indexToken

    usedShortcuts.add(shortcut)

    if (normalizedLabel.length > 0) {
      tokens.add(normalizedLabel)
      completionTokens.add(normalizedLabel)
    }
    const normalizedValue = normalizeApprovalChoiceInput(decision.value)
    if (normalizedValue.length > 0) {
      tokens.add(normalizedValue)
    }
    tokens.add(indexToken)
    completionTokens.add(indexToken)
    tokens.add(shortcut)
    choices.push({
      completionTokens: [...completionTokens],
      decision: decision.value,
      intent: decision.intent,
      indexToken,
      shortcut,
      tokens: [...tokens],
    })
  }
  return choices
}

export function resolveChoice(choices: ReadonlyArray<PromptChoice>, input: string): string | undefined {
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

export function shouldAutoSubmit(choices: ReadonlyArray<PromptChoice>, input: string): boolean {
  const normalized = normalizeApprovalChoiceInput(input)
  const matchedChoice =
    normalized.length === 0 ? undefined : choices.find((choice) => choice.tokens.includes(normalized))
  if (matchedChoice === undefined) {
    return false
  }

  for (const choice of choices) {
    for (const token of choice.completionTokens) {
      if (token.length > normalized.length && token.startsWith(normalized)) {
        return false
      }
    }
  }

  if (matchedChoice.shortcut === normalized && matchedChoice.shortcut !== matchedChoice.indexToken) {
    return true
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

export function resolveAnswer(question: UserInputQuestion, value: string): string | undefined {
  if (!question.allowEmpty && value.trim().length === 0) {
    return undefined
  }

  const answer = question.preserveWhitespace ? value : value.trim()
  return normalizeQuestionAnswer(answer, question.options)
}

function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0))
  for (let i = 0; i <= m; i++) dp[i]![0] = i
  for (let j = 0; j <= n; j++) dp[0]![j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!)
    }
  }
  return dp[m]![n]!
}

export function findClosestChoice(choices: ReadonlyArray<PromptChoice>, input: string): string | undefined {
  const normalized = normalizeApprovalChoiceInput(input)
  if (normalized.length === 0) return undefined

  let best: string | undefined
  let bestDist = Infinity
  for (const choice of choices) {
    for (const token of choice.tokens) {
      const dist = editDistance(normalized, token)
      if (dist < bestDist && dist <= 2) {
        bestDist = dist
        best = choice.decision
      }
    }
  }
  return best
}

function ApprovalPanel({
  request,
  onResolve,
}: {
  request: Extract<InteractionRequest, { kind: "approval" }>
  onResolve: (resolution: InteractionResolution) => void
}) {
  const choices = useMemo(() => buildChoices(request.decisions), [request.decisions])
  const [inputValue, setInputValue] = useState("")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const submitChoice = (value: string): boolean => {
    const decision = resolveChoice(choices, value)
    if (decision === undefined) {
      return false
    }
    onResolve({ decision, kind: "approval" })
    return true
  }

  const handleChange = (value: string) => {
    setInputValue(value)
    setErrorMessage(null)
    if (shouldAutoSubmit(choices, value)) {
      submitChoice(value)
    }
  }

  const handleSubmit = (value: string) => {
    if (submitChoice(value)) {
      return
    }
    const closest = findClosestChoice(choices, value)
    if (closest) {
      setErrorMessage(`Unknown choice. Did you mean "${closest}"?`)
    } else {
      setErrorMessage("Unknown choice. Type a shortcut, number, or exact decision label.")
    }
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{request.requestKind}</Text>: {request.command ?? request.message}
      </Text>
      <Text dimColor>
        {"  "}
        {request.message}
      </Text>
      {request.cwd && (
        <Text dimColor>
          {"  "}cwd: {request.cwd}
        </Text>
      )}
      <Text>{""}</Text>
      <Text>
        {"  "}
        {choices.map((choice) => (
          <Text key={choice.decision}>
            <Text bold color="cyan" underline={choice.intent === "approve"}>
              [{choice.shortcut}]
            </Text>{" "}
            {request.decisions.find((decision) => decision.value === choice.decision)?.label ?? choice.decision}
            {"  "}
          </Text>
        ))}
      </Text>
      <Text>{""}</Text>
      <Box>
        <Text>
          <Text color="cyan">{chars.promptCaret}</Text>{" "}
        </Text>
        <PromptTextInput value={inputValue} onChange={handleChange} onSubmit={handleSubmit} />
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

function UserInputPanel({
  request,
  onResolve,
}: {
  request: Extract<InteractionRequest, { kind: "user_input" }>
  onResolve: (resolution: InteractionResolution) => void
}) {
  const [questionIndex, setQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, { answers: string[] }>>({})
  const [inputValue, setInputValue] = useState(request.questions[0]?.initialValue ?? "")

  const question = request.questions[questionIndex]
  if (question === undefined) {
    return null
  }

  const total = request.questions.length
  const answeredDisplay = request.questions.slice(0, questionIndex).map((q) => ({
    header: q.header,
    answer: answers[q.id]?.answers[0] ?? "",
  }))

  const handleSubmit = (value: string) => {
    const answer = resolveAnswer(question, value)
    if (answer === undefined) {
      return
    }

    const newAnswers = { ...answers, [question.id]: { answers: [answer] } }

    if (questionIndex + 1 >= total) {
      onResolve({ answers: newAnswers, kind: "user_input" })
    } else {
      setAnswers(newAnswers)
      setQuestionIndex(questionIndex + 1)
      setInputValue(request.questions[questionIndex + 1]?.initialValue ?? "")
    }
  }

  const progress = total > 1 ? ` ${questionIndex + 1}/${total}` : ""

  return (
    <Box flexDirection="column">
      {answeredDisplay.map((prev, i) => (
        <Text key={i} dimColor>
          <Text color="green">✓</Text> {prev.header}: {prev.answer}
        </Text>
      ))}
      <Text>
        <Text bold>{question.header}</Text>
        {progress && <Text dimColor>{progress}</Text>}
      </Text>
      {question.question.split("\n").map((line, i) => (
        <Text key={i} dimColor>
          {"  "}
          {line}
        </Text>
      ))}
      {question.options !== null && question.options.length > 0 && (
        <Box flexDirection="column">
          <Text>{""}</Text>
          {question.options.map((option, i) => (
            <Text key={option.label}>
              {"  "}
              <Text bold>{i + 1}.</Text> {option.label}
              {option.description ? <Text dimColor> {option.description}</Text> : null}
            </Text>
          ))}
        </Box>
      )}
      <Text>{""}</Text>
      <Box>
        <Text>
          <Text color="cyan">{chars.promptCaret}</Text>{" "}
        </Text>
        <PromptTextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
      </Box>
    </Box>
  )
}

function ElicitationPanel({
  request,
  onResolve,
}: {
  request: Extract<InteractionRequest, { kind: "elicitation" }>
  onResolve: (resolution: InteractionResolution) => void
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
    const parsed = safeParseJson(value)
    if (parsed.kind === "ok") {
      onResolve({ action: "accept", content: parsed.value, kind: "elicitation" })
    }
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color="cyan">
          ↗
        </Text>{" "}
        <Text bold>{request.message}</Text>
      </Text>
      {request.mode === "url" ? (
        <Text dimColor>
          {"  "}url: {request.url}
        </Text>
      ) : (
        <Text dimColor>
          {"  "}schema: {compactJson(request.requestedSchema ?? {})}
        </Text>
      )}
      <Text>{""}</Text>
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
          <Text>JSON: </Text>
          <PromptTextInput value={jsonInput} onChange={setJsonInput} onSubmit={handleJsonSubmit} />
        </Box>
      )}
    </Box>
  )
}

export function Interaction({
  interaction,
  onResolve,
}: {
  interaction: PendingInteraction
  onResolve: (resolution: InteractionResolution) => void
}) {
  switch (interaction.request.kind) {
    case "approval":
      return <ApprovalPanel request={interaction.request} onResolve={onResolve} />
    case "user_input":
      return <UserInputPanel request={interaction.request} onResolve={onResolve} />
    case "elicitation":
      return <ElicitationPanel request={interaction.request} onResolve={onResolve} />
  }
}
