type ParsedSemver = {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function normalizeVersion(version: string): string {
  const [main, prerelease] = version.trim().split("-", 2)
  const parts = (main ?? "")
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  if (parts.length === 2) {
    parts.push("0")
  }

  return prerelease === undefined ? parts.join(".") : `${parts.join(".")}-${prerelease}`
}

function parseSemver(version: string): ParsedSemver | null {
  const normalized = normalizeVersion(version)
  const [main = "", prerelease] = normalized.split("-", 2)
  const parts = main.split(".")
  if (parts.length !== 3) {
    return null
  }

  const [majorPart, minorPart, patchPart] = parts
  if (majorPart === undefined || minorPart === undefined || patchPart === undefined) {
    return null
  }

  const major = Number.parseInt(majorPart, 10)
  const minor = Number.parseInt(minorPart, 10)
  const patch = Number.parseInt(patchPart, 10)
  if (![major, minor, patch].every(Number.isInteger)) {
    return null
  }

  return {
    major,
    minor,
    patch,
    prerelease:
      prerelease
        ?.split(".")
        .map((part) => part.trim())
        .filter((part) => part.length > 0) ?? [],
  }
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10)
  }
  if (leftNumeric) {
    return -1
  }
  if (rightNumeric) {
    return 1
  }

  return left.localeCompare(right)
}

export function compareVersions(left: string, right: string): number {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (a === null || b === null) {
    return left.localeCompare(right)
  }

  if (a.major !== b.major) {
    return a.major - b.major
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor
  }
  if (a.patch !== b.patch) {
    return a.patch - b.patch
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) {
    return 0
  }
  if (a.prerelease.length === 0) {
    return 1
  }
  if (b.prerelease.length === 0) {
    return -1
  }

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const leftId = a.prerelease[i]
    const rightId = b.prerelease[i]
    if (leftId === undefined) {
      return -1
    }
    if (rightId === undefined) {
      return 1
    }

    const diff = comparePrereleaseIdentifier(leftId, rightId)
    if (diff !== 0) {
      return diff
    }
  }

  return 0
}

export function parseVersion(output: string): string | null {
  const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/.exec(output)
  if (!match?.[1]) {
    return null
  }

  return parseSemver(match[1]) === null ? null : normalizeVersion(match[1])
}
