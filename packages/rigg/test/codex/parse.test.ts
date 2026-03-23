import { describe, expect, test } from "bun:test"

import { parseApproval, parseCollabModes, parseError, parseReviewText } from "../../src/codex/parse"

describe("codex/parse", () => {
  test("parses collaboration mode presets from the app-server", () => {
    expect(
      parseCollabModes({
        data: [
          { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
          { name: "Default", mode: "default", model: null, reasoning_effort: null },
        ],
      }),
    ).toEqual([
      { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
      { name: "Default", mode: "default", model: null, reasoning_effort: null },
    ])
  })

  test("parses command approval params with mixed decision shapes", () => {
    expect(
      parseApproval("command_execution", "approval-1", {
        availableDecisions: [
          "accept",
          "acceptForSession",
          { applyNetworkPolicyAmendment: { host: "registry.npmjs.org" } },
        ],
        command: "npm view @anthropic-ai/claude-agent-sdk version",
        cwd: "/tmp/project",
        itemId: "cmd_1",
        reason: "Need approval",
        turnId: "turn_1",
      }),
    ).toEqual({
      command: "npm view @anthropic-ai/claude-agent-sdk version",
      cwd: "/tmp/project",
      decisions: [
        { intent: "approve", response: "accept", value: "accept" },
        { intent: "approve", response: "acceptForSession", value: "acceptForSession" },
        {
          intent: "approve",
          label: "applyNetworkPolicyAmendment host=registry.npmjs.org",
          response: { applyNetworkPolicyAmendment: { host: "registry.npmjs.org" } },
          value: "applyNetworkPolicyAmendment",
        },
      ],
      itemId: "cmd_1",
      kind: "approval",
      message: "Need approval",
      requestId: "approval-1",
      requestKind: "command_execution",
      turnId: "turn_1",
    })
  })

  test("synthesizes file change approval decisions from generated protocol defaults", () => {
    expect(
      parseApproval("file_change", "approval-2", {
        itemId: "file_1",
        reason: "Need write access",
        turnId: "turn_2",
      }),
    ).toMatchObject({
      decisions: [
        { intent: "approve", value: "accept" },
        { intent: "deny", value: "decline" },
        { intent: "cancel", value: "cancel" },
      ],
      itemId: "file_1",
      requestKind: "file_change",
      turnId: "turn_2",
    })
  })

  test("keeps session-scoped file change approval only when grantRoot is present", () => {
    expect(
      parseApproval("file_change", "approval-2b", {
        grantRoot: "/tmp/project",
        itemId: "file_2",
        reason: "Need write access",
        turnId: "turn_2",
      }),
    ).toMatchObject({
      decisions: [
        { intent: "approve", value: "accept" },
        { intent: "approve", value: "acceptForSession" },
        { intent: "deny", value: "decline" },
        { intent: "cancel", value: "cancel" },
      ],
    })
  })

  test("assigns unique values to repeated object-shaped approval decisions", () => {
    expect(
      parseApproval("command_execution", "approval-1b", {
        availableDecisions: [
          { applyNetworkPolicyAmendment: { action: "allow", host: "registry.npmjs.org" } },
          { applyNetworkPolicyAmendment: { action: "deny", host: "example.com" } },
        ],
        itemId: "cmd_2",
        reason: "Need approval",
        turnId: "turn_1",
      }),
    ).toMatchObject({
      decisions: [
        {
          intent: "approve",
          label: "applyNetworkPolicyAmendment host=registry.npmjs.org action=allow",
          response: { applyNetworkPolicyAmendment: { action: "allow", host: "registry.npmjs.org" } },
          value: "applyNetworkPolicyAmendment:1",
        },
        {
          intent: "approve",
          label: "applyNetworkPolicyAmendment host=example.com action=deny",
          response: { applyNetworkPolicyAmendment: { action: "deny", host: "example.com" } },
          value: "applyNetworkPolicyAmendment:2",
        },
      ],
    })
  })

  test("uses default command approval decisions when app-server sends an empty list", () => {
    expect(
      parseApproval("command_execution", "approval-1ba", {
        availableDecisions: [],
        itemId: "cmd_2a",
        reason: "Need approval",
        turnId: "turn_1",
      }),
    ).toMatchObject({
      decisions: [
        { intent: "approve", response: "accept", value: "accept" },
        { intent: "deny", response: "decline", value: "decline" },
        { intent: "cancel", response: "cancel", value: "cancel" },
      ],
    })
  })

  test("assigns unique values to mixed approval decisions that share the same key", () => {
    expect(
      parseApproval("command_execution", "approval-1bx", {
        availableDecisions: [
          "applyNetworkPolicyAmendment",
          { applyNetworkPolicyAmendment: { action: "allow", host: "registry.npmjs.org" } },
        ],
        itemId: "cmd_2x",
        reason: "Need approval",
        turnId: "turn_1",
      }),
    ).toMatchObject({
      decisions: [
        {
          intent: "approve",
          response: "applyNetworkPolicyAmendment",
          value: "applyNetworkPolicyAmendment:1",
        },
        {
          intent: "approve",
          label: "applyNetworkPolicyAmendment host=registry.npmjs.org action=allow",
          response: { applyNetworkPolicyAmendment: { action: "allow", host: "registry.npmjs.org" } },
          value: "applyNetworkPolicyAmendment:2",
        },
      ],
    })
  })

  test("uses full json labels when summary fields would hide approval differences", () => {
    expect(
      parseApproval("command_execution", "approval-1by", {
        availableDecisions: [
          {
            applyNetworkPolicyAmendment: {
              action: "allow",
              host: "registry.npmjs.org",
              port: "443",
            },
          },
          {
            applyNetworkPolicyAmendment: {
              action: "allow",
              host: "registry.npmjs.org",
              port: "8443",
            },
          },
        ],
        itemId: "cmd_2y",
        reason: "Need approval",
        turnId: "turn_1",
      }),
    ).toMatchObject({
      decisions: [
        {
          intent: "approve",
          label: 'applyNetworkPolicyAmendment {"action":"allow","host":"registry.npmjs.org","port":"443"}',
          response: {
            applyNetworkPolicyAmendment: {
              action: "allow",
              host: "registry.npmjs.org",
              port: "443",
            },
          },
          value: "applyNetworkPolicyAmendment:1",
        },
        {
          intent: "approve",
          label: 'applyNetworkPolicyAmendment {"action":"allow","host":"registry.npmjs.org","port":"8443"}',
          response: {
            applyNetworkPolicyAmendment: {
              action: "allow",
              host: "registry.npmjs.org",
              port: "8443",
            },
          },
          value: "applyNetworkPolicyAmendment:2",
        },
      ],
    })
  })

  test("keeps approve intent for repeated exec-policy amendment decisions", () => {
    expect(
      parseApproval("command_execution", "approval-1c", {
        availableDecisions: [
          { acceptWithExecpolicyAmendment: { command: "npm install", cwd: "/tmp/project" } },
          { acceptWithExecpolicyAmendment: { command: "npm test", cwd: "/tmp/project" } },
        ],
        itemId: "cmd_3",
        reason: "Need approval",
        turnId: "turn_1",
      }),
    ).toMatchObject({
      decisions: [
        {
          intent: "approve",
          label: "acceptWithExecpolicyAmendment cwd=/tmp/project command=npm install",
          response: { acceptWithExecpolicyAmendment: { command: "npm install", cwd: "/tmp/project" } },
          value: "acceptWithExecpolicyAmendment:1",
        },
        {
          intent: "approve",
          label: "acceptWithExecpolicyAmendment cwd=/tmp/project command=npm test",
          response: { acceptWithExecpolicyAmendment: { command: "npm test", cwd: "/tmp/project" } },
          value: "acceptWithExecpolicyAmendment:2",
        },
      ],
    })
  })

  test("synthesizes permissions approval responses", () => {
    expect(
      parseApproval("permissions", "approval-3", {
        itemId: "perm_1",
        permissions: {
          clipboard: { read: true },
          fileSystem: { read: null, write: ["/tmp/project"] },
          network: { enabled: true },
        },
        reason: "Need additional permissions",
        turnId: "turn_3",
      }),
    ).toMatchObject({
      decisions: [
        {
          intent: "approve",
          response: {
            permissions: {
              clipboard: { read: true },
              fileSystem: { read: null, write: ["/tmp/project"] },
              network: { enabled: true },
            },
            scope: "turn",
          },
          value: "grant",
        },
        {
          intent: "approve",
          response: {
            permissions: {
              clipboard: { read: true },
              fileSystem: { read: null, write: ["/tmp/project"] },
              network: { enabled: true },
            },
            scope: "session",
          },
          value: "grant_for_session",
        },
        {
          intent: "deny",
          response: {
            permissions: {},
            scope: "turn",
          },
          value: "decline",
        },
      ],
      itemId: "perm_1",
      requestKind: "permissions",
      turnId: "turn_3",
    })
  })

  test("accepts explicit null thread and turn ids in error notifications", () => {
    expect(
      parseError({
        error: { message: "provider failed" },
        threadId: null,
        turnId: null,
      }),
    ).toEqual({
      message: "provider failed",
      threadId: null,
      turnId: null,
    })
  })

  test("parses a canonical review finding", () => {
    const result = parseReviewText(
      [
        "Looks solid overall with minor polish suggested.",
        "",
        "Review comment:",
        "",
        "- Prefer Stylize helpers — /tmp/file.rs:10-20",
        "  Use .dim()/.bold() chaining instead of manual Style.",
      ].join("\n"),
    )

    expect(result).toEqual({
      findings: [
        {
          body: "Use .dim()/.bold() chaining instead of manual Style.",
          code_location: {
            absolute_file_path: "/tmp/file.rs",
            line_range: {
              end: 20,
              start: 10,
            },
          },
          confidence_score: 0,
          priority: null,
          title: "Prefer Stylize helpers",
        },
      ],
      overall_confidence_score: 0,
      overall_correctness: "unknown",
      overall_explanation: "Looks solid overall with minor polish suggested.",
    })
  })

  test("parses a single-line location", () => {
    const result = parseReviewText(
      ["Review comment:", "- [x] Keep the handler pure — /tmp/file.ts:10", "  Avoid mutating shared state here."].join(
        "\n",
      ),
    )

    expect(result.findings).toEqual([
      {
        body: "Avoid mutating shared state here.",
        code_location: {
          absolute_file_path: "/tmp/file.ts",
          line_range: {
            end: 10,
            start: 10,
          },
        },
        confidence_score: 0,
        priority: null,
        title: "Keep the handler pure",
      },
    ])
  })

  test("parses a column-qualified location into a line range", () => {
    const result = parseReviewText(
      ["Review comment:", "- Narrow the span — /tmp/file.ts:10:2-12:8", "  Point the fix at the exact block."].join(
        "\n",
      ),
    )

    expect(result.findings).toEqual([
      {
        body: "Point the fix at the exact block.",
        code_location: {
          absolute_file_path: "/tmp/file.ts",
          line_range: {
            end: 12,
            start: 10,
          },
        },
        confidence_score: 0,
        priority: null,
        title: "Narrow the span",
      },
    ])
  })

  test("keeps multiline bodies without requiring indentation", () => {
    const result = parseReviewText(
      [
        "Full review comments:",
        "",
        "- Expand the validation — /tmp/file.ts:10-20",
        "First line.",
        "",
        "Second paragraph.",
      ].join("\n"),
    )

    expect(result.findings).toEqual([
      {
        body: ["First line.", "", "Second paragraph."].join("\n"),
        code_location: {
          absolute_file_path: "/tmp/file.ts",
          line_range: {
            end: 20,
            start: 10,
          },
        },
        confidence_score: 0,
        priority: null,
        title: "Expand the validation",
      },
    ])
  })

  test("fails fast on unsupported review bullet locations", () => {
    expect(() =>
      parseReviewText(
        [
          "Review comment:",
          "- Unsupported location — /tmp/file.ts:line-ten",
          "  This should not become a clean review.",
        ].join("\n"),
      ),
    ).toThrow("unsupported code location")
  })
})
