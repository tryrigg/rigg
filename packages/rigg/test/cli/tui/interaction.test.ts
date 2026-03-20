import { describe, expect, test } from "bun:test"

import {
  buildChoices,
  findClosestChoice,
  resolveAnswer,
  resolveChoice,
  shouldAutoSubmit,
} from "../../../src/cli/tui/interaction"

describe("approval prompt choices", () => {
  test("resolves multi-character numeric choices", () => {
    const choices = buildChoices(
      Array.from({ length: 10 }, (_, index) => ({
        intent: null,
        value: `option-${index + 1}`,
      })),
    )

    expect(resolveChoice(choices, "10")).toBe("option-10")
    expect(shouldAutoSubmit(choices, "1")).toBe(false)
    expect(shouldAutoSubmit(choices, "10")).toBe(true)
  })

  test("resolves exact decision labels case-insensitively", () => {
    const choices = buildChoices([
      { intent: "approve", value: "Allow" },
      { intent: null, value: "Ask User" },
    ])

    expect(resolveChoice(choices, "allow")).toBe("Allow")
    expect(resolveChoice(choices, "  ask user  ")).toBe("Ask User")
  })

  test("keeps ambiguous prefixes pending until the token is complete", () => {
    const choices = buildChoices([
      { intent: null, value: "approve" },
      { intent: null, value: "approved" },
    ])

    expect(shouldAutoSubmit(choices, "approve")).toBe(false)
    expect(shouldAutoSubmit(choices, "approved")).toBe(true)
  })

  test("includes intent in built choices", () => {
    const choices = buildChoices([
      { intent: "approve", value: "Allow" },
      { intent: "deny", value: "Deny" },
    ])

    expect(choices[0]?.intent).toBe("approve")
    expect(choices[1]?.intent).toBe("deny")
  })
})

describe("findClosestChoice", () => {
  test("suggests the closest match for typos", () => {
    const choices = buildChoices([
      { intent: "approve", value: "approve" },
      { intent: "deny", value: "deny" },
    ])

    expect(findClosestChoice(choices, "aprove")).toBe("approve")
    expect(findClosestChoice(choices, "dney")).toBe("deny")
  })

  test("returns undefined when no close match exists", () => {
    const choices = buildChoices([
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

    expect(resolveAnswer(question, "  Rigg  ")).toBe("Rigg")
    expect(resolveAnswer(question, "   ")).toBeUndefined()
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

    expect(resolveAnswer(question, "")).toBe("")
    expect(resolveAnswer(question, "   ")).toBe("   ")
    expect(resolveAnswer(question, "  hello  ")).toBe("  hello  ")
  })
})
