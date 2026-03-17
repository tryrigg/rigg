import { describe, expect, test } from "bun:test"

import {
  buildApprovalPromptChoices,
  resolveApprovalChoice,
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
})
