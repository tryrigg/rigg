import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"

import type { ApprovalRequest, InteractionHandler, UserInputRequest } from "../../session/interaction"

export async function resolvePermission(
  interactionHandler: InteractionHandler | undefined,
  permissionMode: "auto_approve" | "default",
  request: PermissionRequest,
  tool: string,
): Promise<"always" | "once" | "reject"> {
  if (permissionMode === "auto_approve") {
    return "always"
  }
  if (interactionHandler === undefined) {
    return "reject"
  }

  const resolution = await interactionHandler(createPermissionRequest(request, tool))
  if (resolution.kind !== "approval") {
    throw new Error(`OpenCode permission flow expected an approval resolution, received ${resolution.kind}.`)
  }
  if (resolution.decision === "once" || resolution.decision === "always" || resolution.decision === "reject") {
    return resolution.decision
  }

  throw new Error(`Unsupported OpenCode permission decision "${resolution.decision}".`)
}

export async function answerQuestion(
  interactionHandler: InteractionHandler | undefined,
  request: QuestionRequest,
): Promise<null | string[][]> {
  if (interactionHandler === undefined) {
    return null
  }

  const input = createUserInputRequest(request)
  const resolution = await interactionHandler(input)
  if (resolution.kind !== "user_input") {
    throw new Error(`OpenCode question flow expected a user_input resolution, received ${resolution.kind}.`)
  }

  return createQuestionAnswers(request, input, resolution.answers)
}

function createUserInputRequest(request: QuestionRequest): UserInputRequest {
  return {
    itemId: request.id,
    kind: "user_input",
    questions: request.questions.map((question, index) => ({
      allowEmpty: false,
      header: question.header.slice(0, 12),
      id: questionId(index),
      isOther: question.custom !== false,
      isSecret: false,
      options: question.options.length === 0 ? null : question.options.map((option) => ({ ...option })),
      preserveWhitespace: true,
      question: formatQuestion(question),
    })),
    requestId: request.id,
    turnId: request.sessionID,
  }
}

function createQuestionAnswers(
  request: QuestionRequest,
  input: UserInputRequest,
  answers: Record<string, { answers: string[] }>,
): string[][] {
  return input.questions.map((question, index) => {
    const values = answers[question.id]?.answers ?? []
    return normalizeQuestionAnswers(values, request.questions[index])
  })
}

function normalizeQuestionAnswers(
  values: string[],
  question: QuestionRequest["questions"][number] | undefined,
): string[] {
  if (question === undefined) {
    return []
  }
  if (!question.multiple) {
    const value = values[0]
    if (value === undefined) {
      return []
    }
    return [normalizeQuestionChoice(value, question.options)]
  }

  return values.flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => normalizeQuestionChoice(part, question.options)),
  )
}

function normalizeQuestionChoice(answer: string, options: QuestionRequest["questions"][number]["options"]): string {
  if (!/^\d+$/.test(answer)) {
    return answer
  }

  const index = Number.parseInt(answer, 10)
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1]?.label ?? answer
  }
  return answer
}

function formatQuestion(question: QuestionRequest["questions"][number]): string {
  if (!question.multiple) {
    return question.question
  }

  return `${question.question}\nEnter one or more answers separated by commas.`
}

function questionId(index: number): string {
  return `question_${index + 1}`
}

function createPermissionRequest(request: PermissionRequest, tool: string): ApprovalRequest {
  const detail = request.patterns.join(", ")

  return {
    command: null,
    cwd: null,
    decisions: [
      {
        intent: "approve",
        label: "Allow once",
        value: "once",
      },
      {
        intent: "approve",
        label: "Always allow",
        value: "always",
      },
      {
        intent: "deny",
        label: "Reject",
        value: "reject",
      },
    ],
    itemId: request.id,
    kind: "approval",
    message: detail.length === 0 ? `Allow ${tool}?` : `Allow ${tool}: ${detail}?`,
    requestId: request.id,
    requestKind: "permissions",
    turnId: request.sessionID,
  }
}
