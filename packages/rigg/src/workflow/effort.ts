import { z } from "zod"

export const Effort = {
  high: "high",
  low: "low",
  medium: "medium",
  xhigh: "xhigh",
} as const

export type Effort = (typeof Effort)[keyof typeof Effort]

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh"])

export const DEFAULT_EFFORT: Effort = "medium"
