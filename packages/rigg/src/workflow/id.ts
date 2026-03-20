import { createDiag, CompileDiagnosticCode, type CompileDiagnostic } from "./diag"

export const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/

export function isIdent(value: string): boolean {
  return IDENT.test(value)
}

export function checkIdent(value: string, label: string, filePath: string): CompileDiagnostic | undefined {
  if (!isIdent(value)) {
    return createDiag(
      CompileDiagnosticCode.InvalidWorkflow,
      `Invalid ${label} \`${value}\`. Identifiers must start with a letter or \`_\` and only contain ASCII letters, digits, \`_\`, or \`-\`.`,
      { filePath },
    )
  }

  return undefined
}

export type NodePath = string
export type FrameId = string

export function rootPath(index: number): NodePath {
  return `/${index}`
}

export function childPath(parent: NodePath, index: number): NodePath {
  return `${parent}/${index}`
}

export function comparePath(left: NodePath, right: NodePath): number {
  const leftParts = left.split("/").filter(Boolean)
  const rightParts = right.split("/").filter(Boolean)
  const len = Math.max(leftParts.length, rightParts.length)

  for (let i = 0; i < len; i += 1) {
    const leftPart = leftParts[i]
    const rightPart = rightParts[i]

    if (leftPart === undefined) {
      return -1
    }
    if (rightPart === undefined) {
      return 1
    }

    const leftNum = Number.parseInt(leftPart, 10)
    const rightNum = Number.parseInt(rightPart, 10)
    const cmp = Number.isNaN(leftNum) || Number.isNaN(rightNum) ? leftPart.localeCompare(rightPart) : leftNum - rightNum
    if (cmp !== 0) {
      return cmp
    }
  }

  return 0
}

function nodePathFileComponent(nodePath: NodePath): string {
  return nodePath
    .split("/")
    .filter(Boolean)
    .map((part) => `s${part.length.toString(16).padStart(8, "0")}_${part}`)
    .join("")
}

export function rootFrame(): FrameId {
  return "root"
}

export function loopScope(frameId: FrameId, nodePath: NodePath): string {
  return `${frameId}.loop.${nodePathFileComponent(nodePath)}`
}

export function loopFrame(loopScope: string, iteration: number): FrameId {
  return `${loopScope}.iter.${iteration}`
}

export function parallelFrame(parentFrameId: FrameId, nodePath: NodePath, branchIndex: number): FrameId {
  return `${parentFrameId}.parallel.${nodePathFileComponent(nodePath)}.branch.${branchIndex}`
}

export function callFrame(parentFrameId: FrameId, nodePath: NodePath): FrameId {
  return `${parentFrameId}.workflow.${nodePathFileComponent(nodePath)}`
}

export function compareFrame(left: FrameId, right: FrameId): number {
  return left.localeCompare(right, undefined, { numeric: true })
}
