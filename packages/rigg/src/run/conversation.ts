import type { ActionNode, FrameId } from "../compile/schema"
import type { ConversationSnapshot, RunSnapshot } from "../history/index"

import { ParallelConversationConflictError, RunExecutionError } from "./error"

type ConversationBinding =
  | { name: string; scope: "workflow" }
  | { name: string; scope: "loop"; scope_id: string }
  | { name: string; scope: "iteration"; scope_id: FrameId }

export type ConversationStore = {
  iterationScopes: Record<string, Record<string, ConversationSnapshot>>
  loopScopes: Record<string, Record<string, ConversationSnapshot>>
  workflow: Record<string, ConversationSnapshot>
}

export function createConversationStore(workflow: Record<string, ConversationSnapshot> = {}): ConversationStore {
  return {
    iterationScopes: {},
    loopScopes: {},
    workflow: { ...workflow },
  }
}

export function cloneConversationStore(store: ConversationStore): ConversationStore {
  return {
    iterationScopes: cloneNestedScopes(store.iterationScopes),
    loopScopes: cloneNestedScopes(store.loopScopes),
    workflow: { ...store.workflow },
  }
}

export function syncWorkflowConversations(runState: RunSnapshot, store: ConversationStore): void {
  runState.conversations = { ...store.workflow }
}

export function resolveConversation(
  store: ConversationStore,
  step: ActionNode,
  scope: {
    iterationFrameId: FrameId
    loopScopeId: string | undefined
  },
): ConversationSnapshot | undefined {
  const binding = conversationBindingForStep(step, scope)
  if (binding === undefined) {
    return undefined
  }

  switch (binding.scope) {
    case "workflow":
      return store.workflow[binding.name]
    case "loop":
      return store.loopScopes[binding.scope_id]?.[binding.name]
    case "iteration":
      return store.iterationScopes[binding.scope_id]?.[binding.name]
  }
}

export function storeConversation(
  store: ConversationStore,
  step: ActionNode,
  scope: {
    iterationFrameId: FrameId
    loopScopeId: string | undefined
  },
  conversation: ConversationSnapshot,
): void {
  const binding = conversationBindingForStep(step, scope)
  if (binding === undefined) {
    return
  }

  switch (binding.scope) {
    case "workflow":
      store.workflow[binding.name] = conversation
      return
    case "loop":
      store.loopScopes[binding.scope_id] ??= {}
      {
        const scopedStore = store.loopScopes[binding.scope_id]
        if (scopedStore !== undefined) {
          scopedStore[binding.name] = conversation
        }
      }
      return
    case "iteration":
      store.iterationScopes[binding.scope_id] ??= {}
      {
        const scopedStore = store.iterationScopes[binding.scope_id]
        if (scopedStore !== undefined) {
          scopedStore[binding.name] = conversation
        }
      }
  }
}

export function clearIterationConversations(store: ConversationStore, iterationFrameId: FrameId): void {
  delete store.iterationScopes[iterationFrameId]
}

export function clearLoopConversations(store: ConversationStore, loopScopeId: string): void {
  delete store.loopScopes[loopScopeId]
}

export function mergeParallelConversationStore(
  current: ConversationStore,
  base: ConversationStore,
  branch: ConversationStore,
): void {
  mergeScopeUpdates(current.workflow, base.workflow, branch.workflow, () => "workflow")
  mergeNestedScopeUpdates(current.loopScopes, base.loopScopes, branch.loopScopes, (scope) => scope)
  mergeNestedScopeUpdates(current.iterationScopes, base.iterationScopes, branch.iterationScopes, (scope) => scope)
}

function conversationBindingForStep(
  step: ActionNode,
  scope: {
    iterationFrameId: FrameId
    loopScopeId: string | undefined
  },
): ConversationBinding | undefined {
  const conversation =
    step.type === "claude"
      ? step.with.conversation
      : step.type === "codex" && step.with.action === "exec"
        ? step.with.conversation
        : undefined
  if (conversation === undefined) {
    return undefined
  }

  const resolvedScope = conversation.scope ?? (scope.loopScopeId === undefined ? "workflow" : "iteration")
  switch (resolvedScope) {
    case "workflow":
      return { name: conversation.name, scope: "workflow" }
    case "loop":
      if (scope.loopScopeId === undefined) {
        throw new RunExecutionError(`conversation scope \`${resolvedScope}\` can only be used inside loops`, {
          runReason: "step_failed",
        })
      }
      return {
        name: conversation.name,
        scope: "loop",
        scope_id: scope.loopScopeId,
      }
    case "iteration":
      if (scope.loopScopeId === undefined) {
        throw new RunExecutionError(`conversation scope \`${resolvedScope}\` can only be used inside loops`, {
          runReason: "step_failed",
        })
      }
      return {
        name: conversation.name,
        scope: "iteration",
        scope_id: scope.iterationFrameId,
      }
  }
}

function cloneNestedScopes(
  scopes: Record<string, Record<string, ConversationSnapshot>>,
): Record<string, Record<string, ConversationSnapshot>> {
  return Object.fromEntries(Object.entries(scopes).map(([key, value]) => [key, { ...value }]))
}

function mergeScopeUpdates(
  current: Record<string, ConversationSnapshot>,
  base: Record<string, ConversationSnapshot>,
  branch: Record<string, ConversationSnapshot>,
  scopeName: (name: string) => string,
): void {
  for (const [name, handle] of Object.entries(branch)) {
    if (sameConversation(base[name], handle)) {
      continue
    }
    const existing = current[name]
    if (sameConversation(existing, handle)) {
      continue
    }
    if (existing === undefined || sameConversation(base[name], existing)) {
      current[name] = handle
      continue
    }
    throw new ParallelConversationConflictError(name, scopeName(name))
  }
}

function mergeNestedScopeUpdates(
  current: Record<string, Record<string, ConversationSnapshot>>,
  base: Record<string, Record<string, ConversationSnapshot>>,
  branch: Record<string, Record<string, ConversationSnapshot>>,
  scopeName: (scope: string, name: string) => string,
): void {
  for (const [owner, branchConversations] of Object.entries(branch)) {
    const baseConversations = base[owner] ?? {}
    current[owner] ??= {}
    const currentConversations = current[owner]
    for (const [name, handle] of Object.entries(branchConversations)) {
      if (sameConversation(baseConversations[name], handle)) {
        continue
      }
      const existing = currentConversations[name]
      if (sameConversation(existing, handle)) {
        continue
      }
      if (existing === undefined || sameConversation(baseConversations[name], existing)) {
        currentConversations[name] = handle
        continue
      }
      throw new ParallelConversationConflictError(name, scopeName(owner, name))
    }
  }
}

function sameConversation(left: ConversationSnapshot | undefined, right: ConversationSnapshot | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }
  return left.id === right.id && left.provider === right.provider
}
