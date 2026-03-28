import type { InteractionRequest, InteractionResolution } from "../../session/interaction"

export function assertResolutionKind<TKind extends InteractionRequest["kind"]>(
  expected: TKind,
  resolution: InteractionResolution,
): asserts resolution is Extract<InteractionResolution, { kind: TKind }> {
  if (resolution.kind !== expected) {
    throw new Error(`interaction handler returned ${resolution.kind} for ${expected}`)
  }
}

export function assertApprovalDecision(
  request: Extract<InteractionRequest, { kind: "approval" }>,
  decision: string,
): void {
  if (request.decisions.some((candidate) => candidate.value === decision)) {
    return
  }

  throw new Error(`interaction handler returned invalid approval decision: ${decision}`)
}

export function approvalResponse(
  request: Extract<InteractionRequest, { kind: "approval" }>,
  decision: string,
): unknown {
  const match = request.decisions.find((candidate) => candidate.value === decision)
  return match?.response ?? decision
}

export function permApprovalResponse(
  request: Extract<InteractionRequest, { kind: "approval" }>,
  decision: string,
): { permissions: Record<string, unknown>; scope: "turn" | "session" } {
  const value = approvalResponse(request, decision)
  const parsed = parsePermResponse(value)
  if (parsed !== null) {
    return parsed
  }

  return {
    permissions: {},
    scope: "turn",
  }
}

function parsePermResponse(value: unknown): { permissions: Record<string, unknown>; scope: "turn" | "session" } | null {
  if (value === null || typeof value !== "object") {
    return null
  }
  if (!("permissions" in value) || !("scope" in value)) {
    return null
  }

  const permissions = value.permissions
  const scope = value.scope
  if (!isRecord(permissions)) {
    return null
  }
  if (scope !== "turn" && scope !== "session") {
    return null
  }

  return { permissions, scope }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}
