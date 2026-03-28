import { describe, expect, test } from "bun:test"

import type { OpenCodeProviderEvent } from "../../../src/provider/opencode/event"

describe("opencode/event", () => {
  test("supports permission events in the provider union", () => {
    const requested = {
      detail: "src/index.ts",
      kind: "permission_requested",
      message: "Allow edit?",
      permissionId: "perm_1",
      provider: "opencode",
      sessionId: "session_1",
      tool: "edit",
    } satisfies OpenCodeProviderEvent

    const resolved = {
      decision: "always",
      kind: "permission_resolved",
      permissionId: "perm_1",
      provider: "opencode",
      sessionId: "session_1",
      tool: "edit",
    } satisfies OpenCodeProviderEvent

    expect(requested.kind).toBe("permission_requested")
    expect(resolved.decision).toBe("always")
  })
})
