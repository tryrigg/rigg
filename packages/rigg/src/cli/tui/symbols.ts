import figures from "figures"

import type { NodeKind, NodeStatus, RunStatus } from "../../session/schema"
import { formatDurationText } from "../../history/render"
import { colors, kindColors } from "./theme"

export type StatusSymbol = { icon: string; color: string }
export type DisplayStatus = NodeStatus | RunStatus | "not_started" | "retrying"

export function statusSymbol(status: DisplayStatus): StatusSymbol {
  switch (status) {
    case "not_started":
    case "pending":
      return { icon: figures.circle, color: colors.muted }
    case "running":
      return { icon: figures.lozenge, color: colors.brand }
    case "retrying":
      return { icon: "⟳", color: colors.brand }
    case "succeeded":
      return { icon: figures.tick, color: colors.success }
    case "failed":
      return { icon: figures.cross, color: colors.error }
    case "aborted":
      return { icon: figures.warning, color: colors.warning }
    case "skipped":
      return { icon: figures.circleDotted, color: colors.muted }
    case "interrupted":
      return { icon: figures.warning, color: colors.brand }
    case "waiting_for_interaction":
      return { icon: figures.lozengeOutline, color: colors.warning }
  }
}

export function kindColor(kind: string): string {
  return isNodeKind(kind) ? kindColors[kind] : "dim"
}

export function formatDuration(ms: number): string {
  return formatDurationText(ms)
}

function isNodeKind(kind: string): kind is NodeKind {
  return kind in kindColors
}
