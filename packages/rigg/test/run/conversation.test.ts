import { describe, expect, test } from "bun:test"

import {
  clearIterationConversations,
  clearLoopConversations,
  cloneConversationStore,
  createConversationStore,
  mergeParallelConversationStore,
  resolveConversation,
  storeConversation,
  syncWorkflowConversations,
} from "../../src/run/conversation"
import { ParallelConversationConflictError, RunExecutionError } from "../../src/run/error"
import type { ActionNode } from "../../src/compile/schema"
import { runSnapshot } from "../fixture/builders"

const workflowScope = {
  iterationFrameId: "root",
  loopScopeId: undefined,
} as const

const loopScope = {
  iterationFrameId: "root.loop.s00000001_0.iter.1",
  loopScopeId: "root.loop.s00000001_0",
} as const

function claudeStep(conversation?: { name: string; scope?: "iteration" | "loop" | "workflow" }): ActionNode {
  return {
    type: "claude",
    with: {
      action: "prompt",
      ...(conversation === undefined ? {} : { conversation }),
      prompt: "Draft",
    },
  }
}

function codexExecStep(conversation?: { name: string; scope?: "iteration" | "loop" | "workflow" }): ActionNode {
  return {
    type: "codex",
    with: {
      action: "exec",
      ...(conversation === undefined ? {} : { conversation }),
      prompt: "Edit",
    },
  }
}

describe("run/conversation", () => {
  test("stores and resolves workflow-scoped conversations", () => {
    const store = createConversationStore()
    const step = claudeStep({ name: "review" })

    storeConversation(store, step, workflowScope, { id: "claude-1", provider: "claude" })

    expect(resolveConversation(store, step, workflowScope)).toEqual({ id: "claude-1", provider: "claude" })
  })

  test("stores loop-scoped and iteration-scoped conversations inside loops", () => {
    const store = createConversationStore()

    storeConversation(store, claudeStep({ name: "loop-review", scope: "loop" }), loopScope, {
      id: "claude-loop",
      provider: "claude",
    })
    storeConversation(store, codexExecStep({ name: "iter-edit", scope: "iteration" }), loopScope, {
      id: "codex-iter",
      provider: "codex",
    })

    expect(resolveConversation(store, claudeStep({ name: "loop-review", scope: "loop" }), loopScope)).toEqual({
      id: "claude-loop",
      provider: "claude",
    })
    expect(resolveConversation(store, codexExecStep({ name: "iter-edit", scope: "iteration" }), loopScope)).toEqual({
      id: "codex-iter",
      provider: "codex",
    })
  })

  test("rejects loop-only scopes outside loops", () => {
    expect(() =>
      resolveConversation(createConversationStore(), claudeStep({ name: "review", scope: "loop" }), workflowScope),
    ).toThrow(RunExecutionError)
    expect(() =>
      storeConversation(createConversationStore(), claudeStep({ name: "review", scope: "iteration" }), workflowScope, {
        id: "claude-1",
        provider: "claude",
      }),
    ).toThrow("conversation scope `iteration` can only be used inside loops")
  })

  test("clones, syncs, and clears conversations", () => {
    const store = createConversationStore({ workflow: { id: "claude-1", provider: "claude" } })
    storeConversation(store, claudeStep({ name: "loop-review", scope: "loop" }), loopScope, {
      id: "claude-loop",
      provider: "claude",
    })
    storeConversation(store, codexExecStep({ name: "iter-edit", scope: "iteration" }), loopScope, {
      id: "codex-iter",
      provider: "codex",
    })

    const cloned = cloneConversationStore(store)
    cloned.workflow["workflow"] = { id: "claude-2", provider: "claude" }

    expect(store.workflow["workflow"]).toEqual({ id: "claude-1", provider: "claude" })

    const snapshot = runSnapshot()
    syncWorkflowConversations(snapshot, store)
    expect(snapshot.conversations).toEqual({ workflow: { id: "claude-1", provider: "claude" } })

    clearIterationConversations(store, loopScope.iterationFrameId)
    clearLoopConversations(store, loopScope.loopScopeId)

    expect(store.iterationScopes).toEqual({})
    expect(store.loopScopes).toEqual({})
  })

  test("merges parallel conversation stores and detects conflicts", () => {
    const current = createConversationStore({ review: { id: "claude-1", provider: "claude" } })
    const base = createConversationStore({ review: { id: "claude-1", provider: "claude" } })
    const branch = createConversationStore({ review: { id: "claude-2", provider: "claude" } })

    mergeParallelConversationStore(current, base, branch)
    expect(current.workflow["review"]).toEqual({ id: "claude-2", provider: "claude" })

    const conflictingCurrent = createConversationStore({ review: { id: "claude-9", provider: "claude" } })
    expect(() =>
      mergeParallelConversationStore(
        conflictingCurrent,
        createConversationStore({ review: { id: "claude-1", provider: "claude" } }),
        createConversationStore({ review: { id: "claude-2", provider: "claude" } }),
      ),
    ).toThrow(ParallelConversationConflictError)
  })
})
