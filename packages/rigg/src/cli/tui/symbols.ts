import figures from "figures"

import type { NodeStatus } from "../../run/schema"
import { colors, kindColors } from "./theme"

export type StatusSymbol = { icon: string; color: string }

export function statusSymbol(status: NodeStatus | "not_started"): StatusSymbol {
  switch (status) {
    case "not_started":
    case "pending":
      return { icon: figures.circle, color: colors.muted }
    case "running":
      return { icon: figures.lozenge, color: colors.brand }
    case "succeeded":
      return { icon: figures.tick, color: colors.success }
    case "failed":
      return { icon: figures.cross, color: colors.error }
    case "skipped":
      return { icon: figures.circleDotted, color: colors.muted }
    case "interrupted":
      return { icon: figures.warning, color: colors.brand }
    case "waiting_for_interaction":
      return { icon: figures.lozengeOutline, color: colors.warning }
  }
}

export function kindColor(kind: string): string {
  return kindColors[kind] ?? "dim"
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  return `${(ms / 1000).toFixed(1)}s`
}
