import { describe, expect, test } from "bun:test"

import {
  parseExtensionRequest,
  parsePermissionRequest,
  parseSessionNew,
  parseSessionUpdate,
  parseSessionUpdates,
} from "../../src/cursor/parse"

describe("cursor/parse", () => {
  test("parses session/new responses", () => {
    expect(parseSessionNew({ sessionId: "session_1" })).toBe("session_1")
  })

  test("parses cursor extension interaction requests", () => {
    expect(
      parseExtensionRequest("cursor/ask_question", "req_ask", {
        question: "Need clarification",
        questionId: "question_1",
        sessionId: "session_1",
        options: [
          { id: "frontend", label: "Frontend" },
          { id: "backend", label: "Backend" },
        ],
      }),
    ).toEqual({
      command: undefined,
      cwd: undefined,
      decisions: [
        { intent: null, value: "frontend" },
        { intent: null, value: "backend" },
      ],
      itemId: "question_1",
      kind: "approval",
      message: "Need clarification",
      requestId: "req_ask",
      requestKind: "permissions",
      turnId: "session_1",
    })

    expect(
      parseExtensionRequest("cursor/create_plan", "req_plan", {
        message: "Approve this implementation plan",
        plan: { text: "1. Inspect\n2. Patch", type: "text" },
        planId: "plan_1",
        sessionId: "session_2",
        options: [
          { kind: "approve", optionId: "accept" },
          { kind: "deny", optionId: "reject" },
        ],
      }),
    ).toEqual({
      command: undefined,
      cwd: undefined,
      decisions: [
        { intent: "approve", value: "accept" },
        { intent: "deny", value: "reject" },
      ],
      itemId: "plan_1",
      kind: "approval",
      message: "Approve this implementation plan\n\n1. Inspect\n2. Patch",
      requestId: "req_plan",
      requestKind: "permissions",
      turnId: "session_2",
    })
  })

  test("parses standard ACP session/update payloads", () => {
    const cases = [
      {
        expected: {
          kind: "message_delta",
          messageId: "msg_1",
          sessionId: "session_1",
          text: "hello",
        },
        input: {
          sessionId: "session_1",
          update: {
            content: { text: "hello", type: "text" },
            messageId: "msg_1",
            sessionUpdate: "agent_message_chunk",
          },
        },
      },
      {
        expected: {
          kind: "noop",
          sessionId: "session_1",
        },
        input: {
          sessionId: "session_1",
          update: {
            content: { text: "original prompt", type: "text" },
            sessionUpdate: "user_message_chunk",
          },
        },
      },
      {
        expected: {
          kind: "noop",
          sessionId: "session_1",
        },
        input: {
          sessionId: "session_1",
          update: {
            sessionUpdate: "agent_thought_chunk",
          },
        },
      },
      {
        expected: {
          kind: "noop",
          sessionId: "session_1",
        },
        input: {
          sessionId: "session_1",
          update: {
            entries: [],
            sessionUpdate: "plan",
          },
        },
      },
      {
        expected: {
          kind: "tool_call",
          sessionId: "session_1",
        },
        input: {
          sessionId: "session_1",
          update: {
            sessionUpdate: "tool_call",
            status: "pending",
            title: "Run formatter",
            toolCallId: "call_1",
          },
        },
      },
      {
        expected: {
          kind: "tool_call",
          sessionId: "session_1",
        },
        input: {
          sessionId: "session_1",
          update: {
            sessionUpdate: "tool_call_update",
            status: "completed",
            toolCallId: "call_1",
          },
        },
      },
      {
        expected: {
          kind: "diagnostic",
          message: "checking workspace",
          sessionId: "session_1",
        },
        input: {
          sessionId: "session_1",
          update: {
            message: "checking workspace",
            sessionUpdate: "diagnostic",
          },
        },
      },
      {
        expected: {
          kind: "error",
          message: "cursor provider failed",
          sessionId: "session_1",
        },
        input: {
          sessionId: "session_1",
          update: {
            message: "cursor provider failed",
            sessionUpdate: "error",
          },
        },
      },
      {
        expected: {
          decisions: [
            { intent: "approve", shortcut: "a", value: "code" },
            { intent: "approve", shortcut: "y", value: "ask" },
            { intent: "deny", value: "reject" },
          ],
          itemId: "call_switch_mode_001",
          kind: "approval",
          message: "Ready for implementation\n\n## Implementation Plan...",
          requestId: "req_1",
          requestKind: "permissions",
          turnId: "session_1",
        },
        input: {
          options: [
            { kind: "allow_always", name: "Yes, and auto-accept all actions", optionId: "code" },
            { kind: "allow_once", name: "Yes, and manually accept actions", optionId: "ask" },
            { kind: "reject_once", name: "No, stay in architect mode", optionId: "reject" },
          ],
          sessionId: "session_1",
          toolCall: {
            content: [{ text: "## Implementation Plan...", type: "text" }],
            kind: "switch_mode",
            status: "pending",
            title: "Ready for implementation",
            toolCallId: "call_switch_mode_001",
          },
        },
        parse: "permission_acp",
      },
    ] as const

    expect(parseSessionUpdate(cases[0].input)).toEqual(cases[0].expected)
    expect(parseSessionUpdate(cases[1].input)).toEqual(cases[1].expected)
    expect(parseSessionUpdate(cases[2].input)).toEqual(cases[2].expected)
    expect(parseSessionUpdate(cases[3].input)).toEqual(cases[3].expected)
    expect(parseSessionUpdate(cases[4].input)).toEqual(cases[4].expected)
    expect(parseSessionUpdate(cases[5].input)).toEqual(cases[5].expected)
    expect(parseSessionUpdate(cases[6].input)).toEqual(cases[6].expected)
    expect(parseSessionUpdate(cases[7].input)).toEqual(cases[7].expected)
    expect(parsePermissionRequest("req_1", cases[8].input)).toEqual({
      ...cases[8].expected,
      command: undefined,
      cwd: undefined,
      decisions: [...cases[8].expected.decisions],
    })
  })

  test("rejects invalid ACP payloads", () => {
    expect(parseSessionUpdate({ sessionId: "session_1", update: "not-an-object" })).toEqual({
      kind: "unknown",
      sessionId: "session_1",
      type: "invalid_envelope",
    })
    expect(
      parseSessionUpdate({
        sessionId: "session_1",
        update: [{ sessionUpdate: "agent_message_chunk" }],
      }),
    ).toEqual({
      kind: "unknown",
      sessionId: "session_1",
      type: "invalid_envelope",
    })
    expect(() => parsePermissionRequest("req_1", { sessionId: "session_1" })).toThrow(
      "cursor acp sent invalid session/request_permission payload",
    )
    expect(() => parseExtensionRequest("cursor/ask_question", "req_2", { sessionId: "session_1" })).toThrow(
      "cursor acp sent cursor/ask_question payload without selectable options",
    )
  })

  test("returns a single parsed update for standard envelopes", () => {
    expect(
      parseSessionUpdates({
        sessionId: "session_1",
        update: {
          content: { text: "hello", type: "text" },
          messageId: "msg_1",
          sessionUpdate: "agent_message_chunk",
        },
      }),
    ).toEqual([
      {
        kind: "message_delta",
        messageId: "msg_1",
        sessionId: "session_1",
        text: "hello",
      },
    ])
  })
})
