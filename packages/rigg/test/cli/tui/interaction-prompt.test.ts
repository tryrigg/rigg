import { describe, expect, test } from "bun:test"

import {
  buildApprovalPromptChoices,
  findClosestChoice,
  resolveApprovalChoice,
  resolveUserInputAnswer,
  shouldAutoSubmitApprovalChoice,
} from "../../../src/cli/tui/interaction-prompt"

describe("approval prompt choices", () => {
  test("resolves multi-character numeric choices", () => {
    const choices = buildApprovalPromptChoices(
      Array.from({ length: 10 }, (_, index) => ({
        intent: null,
        value: `option-${index + 1}`,
      })),
    )

    expect(resolveApprovalChoice(choices, "10")).toBe("option-10")
    expect(shouldAutoSubmitApprovalChoice(choices, "1")).toBe(false)
    expect(shouldAutoSubmitApprovalChoice(choices, "10")).toBe(true)
  })

  test("resolves exact decision labels case-insensitively", () => {
    const choices = buildApprovalPromptChoices([
      { intent: "approve", value: "Allow" },
      { intent: null, value: "Ask User" },
    ])

    expect(resolveApprovalChoice(choices, "allow")).toBe("Allow")
    expect(resolveApprovalChoice(choices, "  ask user  ")).toBe("Ask User")
  })

  test("keeps ambiguous prefixes pending until the token is complete", () => {
    const choices = buildApprovalPromptChoices([
      { intent: null, value: "approve" },
      { intent: null, value: "approved" },
    ])

    expect(shouldAutoSubmitApprovalChoice(choices, "approve")).toBe(false)
    expect(shouldAutoSubmitApprovalChoice(choices, "approved")).toBe(true)
  })

  test("includes intent in built choices", () => {
    const choices = buildApprovalPromptChoices([
      { intent: "approve", value: "Allow" },
      { intent: "deny", value: "Deny" },
    ])

    expect(choices[0]?.intent).toBe("approve")
    expect(choices[1]?.intent).toBe("deny")
  })
})

describe("findClosestChoice", () => {
  test("suggests the closest match for typos", () => {
    const choices = buildApprovalPromptChoices([
      { intent: "approve", value: "approve" },
      { intent: "deny", value: "deny" },
    ])

    expect(findClosestChoice(choices, "aprove")).toBe("approve")
    expect(findClosestChoice(choices, "dney")).toBe("deny")
  })

  test("returns undefined when no close match exists", () => {
    const choices = buildApprovalPromptChoices([
      { intent: "approve", value: "approve" },
      { intent: "deny", value: "deny" },
    ])

    expect(findClosestChoice(choices, "something completely different")).toBeUndefined()
  })
})

describe("user input answers", () => {
  test("trims generic free-form answers and rejects blank submissions", () => {
    const question = {
      header: "name",
      id: "name",
      isOther: false,
      isSecret: false,
      options: null,
      question: "Enter a name",
    } as const

    expect(resolveUserInputAnswer(question, "  Rigg  ")).toBe("Rigg")
    expect(resolveUserInputAnswer(question, "   ")).toBeUndefined()
  })

  test("preserves raw workflow input answers, including empty and whitespace-only strings", () => {
    const question = {
      allowEmpty: true,
      header: "note",
      id: "note",
      isOther: false,
      isSecret: false,
      options: null,
      preserveWhitespace: true,
      question: "Enter a note",
    } as const

    expect(resolveUserInputAnswer(question, "")).toBe("")
    expect(resolveUserInputAnswer(question, "   ")).toBe("   ")
    expect(resolveUserInputAnswer(question, "  hello  ")).toBe("  hello  ")
  })
})
