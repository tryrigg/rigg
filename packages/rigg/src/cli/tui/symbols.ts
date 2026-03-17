import figures from "figures"

import type { NodeStatus } from "../../run/schema"

export type StatusSymbol = { icon: string; color: string }

export function statusSymbol(status: NodeStatus | "not_started"): StatusSymbol {
  switch (status) {
    case "not_started":
    case "pending":
      return { icon: figures.circle, color: "dim" }
    case "running":
      return { icon: figures.lozenge, color: "cyan" }
    case "succeeded":
      return { icon: figures.tick, color: "green" }
    case "failed":
      return { icon: figures.cross, color: "red" }
    case "skipped":
      return { icon: figures.circleDotted, color: "dim" }
    case "interrupted":
      return { icon: figures.warning, color: "cyan" }
    case "waiting_for_interaction":
      return { icon: figures.questionMarkPrefix, color: "cyan" }
  }
}

export type KindTag = { icon: string; color: string }

export function kindTag(kind: string): KindTag {
  switch (kind) {
    case "shell":
      return { icon: figures.play, color: "dim" }
    case "codex":
      return { icon: figures.star, color: "dim" }
    case "write_file":
      return { icon: figures.arrowRight, color: "dim" }
    case "group":
      return { icon: figures.squareSmallFilled, color: "dim" }
    case "loop":
      return { icon: figures.circleFilled, color: "dim" }
    case "parallel":
      return { icon: figures.arrowLeftRight, color: "dim" }
    case "branch":
      return { icon: figures.triangleRightSmall, color: "dim" }
    case "branch_case":
      return { icon: figures.pointerSmall, color: "dim" }
    default:
      return { icon: figures.dot, color: "dim" }
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  return `${(ms / 1000).toFixed(1)}s`
}
