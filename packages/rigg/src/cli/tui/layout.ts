import { chars } from "./theme"

const TERMINAL_SAFETY_COLUMNS = 2
const HEADER_LABEL = `${chars.bullet} rigg`
const ELLIPSIS = "..."

type HeaderLayout = {
  elapsedText: string
  gap: number
  left: string
  statusText: string
}

function safeColumns(cols: number): number {
  return Math.max(0, cols - TERMINAL_SAFETY_COLUMNS)
}

function truncateEnd(value: string, maxColumns: number): string {
  if (maxColumns <= 0) {
    return ""
  }
  if (value.length <= maxColumns) {
    return value
  }
  if (maxColumns <= ELLIPSIS.length) {
    return ".".repeat(maxColumns)
  }
  return value.slice(0, Math.max(0, maxColumns - ELLIPSIS.length)) + ELLIPSIS
}

function fitHeaderRight(options: { available: number; elapsed: string; status: string }): {
  elapsedText: string
  statusText: string
} {
  const full = `${options.elapsed} ${options.status}`
  if (full.length <= options.available) {
    return {
      elapsedText: options.elapsed,
      statusText: options.status,
    }
  }

  if (options.status.length <= options.available) {
    return {
      elapsedText: "",
      statusText: options.status,
    }
  }

  return {
    elapsedText: "",
    statusText: truncateEnd(options.status, options.available),
  }
}

function buildHeaderLeft(options: { budget: number; stepProgress?: string | undefined; workflowId: string }): string {
  if (options.budget <= 0) {
    return ""
  }

  const appLabel = HEADER_LABEL.slice(0, Math.min(options.budget, HEADER_LABEL.length))
  let output = appLabel
  let remaining = options.budget - appLabel.length

  if (remaining <= 1 || options.workflowId.length === 0) {
    return output + " ".repeat(Math.min(2, remaining))
  }

  output += " "
  remaining -= 1
  const workflowLabel = truncateEnd(options.workflowId, remaining)
  output += workflowLabel
  remaining -= workflowLabel.length

  if (options.stepProgress && remaining >= options.stepProgress.length + 2) {
    output += "  " + options.stepProgress
    remaining -= options.stepProgress.length + 2
  }

  return " ".repeat(Math.min(2, remaining)) + output
}

export function layoutHeaderLine(options: {
  cols: number
  elapsed: string
  status: string
  stepProgress?: string | undefined
  workflowId: string
}): HeaderLayout {
  const available = safeColumns(options.cols)
  const right = fitHeaderRight({
    available,
    elapsed: options.elapsed,
    status: options.status,
  })
  const rightWidth =
    right.elapsedText.length > 0 ? right.elapsedText.length + 1 + right.statusText.length : right.statusText.length
  const leftAndGapBudget = Math.max(0, available - rightWidth)
  const leftBudget = Math.max(0, leftAndGapBudget - 1)
  const left = buildHeaderLeft({
    budget: leftBudget,
    stepProgress: options.stepProgress,
    workflowId: options.workflowId,
  })
  const gap = left.length > 0 ? Math.max(1, available - left.length - rightWidth) : Math.max(0, leftAndGapBudget)

  return {
    elapsedText: right.elapsedText,
    gap,
    left,
    statusText: right.statusText,
  }
}

export function renderRule(cols: number, prefix = "  "): string {
  return prefix + chars.rule.repeat(Math.max(0, safeColumns(cols) - prefix.length))
}
