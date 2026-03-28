export type CodexReviewResult = {
  findings: Array<{
    body: string
    code_location: {
      absolute_file_path: string
      line_range: {
        end: number
        start: number
      }
    }
    confidence_score: number
    priority?: number | null | undefined
    title: string
  }>
  overall_confidence_score: number
  overall_correctness: string
  overall_explanation: string
}

export function parseReviewText(text: string): CodexReviewResult {
  const normalized = text.trim()
  const marker = normalized.indexOf("\nReview comment:")
  const pluralMarker = normalized.indexOf("\nFull review comments:")
  const headingIndex =
    marker >= 0
      ? marker + 1
      : pluralMarker >= 0
        ? pluralMarker + 1
        : normalized.startsWith("Review comment:") || normalized.startsWith("Full review comments:")
          ? 0
          : -1

  const explanation = (headingIndex >= 0 ? normalized.slice(0, headingIndex) : normalized).trim()
  const findingsBlock = headingIndex >= 0 ? normalized.slice(headingIndex) : ""

  return {
    findings: parseReviewFindings(findingsBlock),
    overall_confidence_score: 0,
    overall_correctness: "unknown",
    overall_explanation: explanation.length > 0 ? explanation : normalized,
  }
}

function parseReviewFindings(block: string): CodexReviewResult["findings"] {
  const findings: CodexReviewResult["findings"] = []
  let current:
    | {
        bodyLines: string[]
        location: string
        title: string
      }
    | undefined

  for (const line of block.split(/\r?\n/)) {
    if (isReviewBulletLine(line)) {
      const header = parseReviewFindingHeader(line)
      if (header === null) {
        throw new Error(`Codex review returned an unsupported finding header: ${line.trim()}`)
      }

      if (current !== undefined) {
        findings.push(finalizeReviewFinding(current))
      }
      current = {
        bodyLines: [],
        location: header.location,
        title: header.title,
      }
      continue
    }

    if (current !== undefined) {
      current.bodyLines.push(line.startsWith("  ") ? line.slice(2) : line)
    }
  }

  if (current !== undefined) {
    findings.push(finalizeReviewFinding(current))
  }

  return findings
}

function finalizeReviewFinding(input: {
  bodyLines: string[]
  location: string
  title: string
}): CodexReviewResult["findings"][number] {
  const location = parseReviewFindingLocation(input.location)
  if (location === null) {
    throw new Error(`Codex review returned an unsupported code location: ${input.location}`)
  }

  return {
    body: input.bodyLines.join("\n"),
    code_location: {
      absolute_file_path: location.absoluteFilePath,
      line_range: {
        end: location.end,
        start: location.start,
      },
    },
    confidence_score: 0,
    priority: null,
    title: input.title.trim(),
  }
}

function isReviewBulletLine(line: string): boolean {
  return line.startsWith("- ") || line.startsWith("- [x] ") || line.startsWith("- [ ] ")
}

function parseReviewFindingHeader(line: string): { location: string; title: string } | null {
  const bullet = /^- (?:\[[x ]\] )?(?<content>.+)$/.exec(line)
  const content = bullet?.groups?.["content"]?.trim()
  if (content === undefined || content.length === 0) {
    return null
  }

  const separatorIndex = content.lastIndexOf(" — ")
  if (separatorIndex <= 0) {
    return null
  }

  const title = content.slice(0, separatorIndex).trim()
  const location = content.slice(separatorIndex + " — ".length).trim()
  if (title.length === 0 || location.length === 0) {
    return null
  }

  return { location, title }
}

function parseReviewFindingLocation(location: string): { absoluteFilePath: string; end: number; start: number } | null {
  const normalized = location.trim()

  const columnRange = /^(.*):(\d+):(\d+)-(\d+):(\d+)$/.exec(normalized)
  if (columnRange !== null) {
    const absoluteFilePath = columnRange[1]
    const start = columnRange[2]
    const end = columnRange[4]
    if (absoluteFilePath === undefined || start === undefined || end === undefined) {
      return null
    }

    return {
      absoluteFilePath,
      end: Number.parseInt(end, 10),
      start: Number.parseInt(start, 10),
    }
  }

  const lineRange = /^(.*):(\d+)-(\d+)$/.exec(normalized)
  if (lineRange !== null) {
    const absoluteFilePath = lineRange[1]
    const start = lineRange[2]
    const end = lineRange[3]
    if (absoluteFilePath === undefined || start === undefined || end === undefined) {
      return null
    }

    return {
      absoluteFilePath,
      end: Number.parseInt(end, 10),
      start: Number.parseInt(start, 10),
    }
  }

  const singleLine = /^(.*):(\d+)$/.exec(normalized)
  if (singleLine !== null) {
    const absoluteFilePath = singleLine[1]
    const lineText = singleLine[2]
    if (absoluteFilePath === undefined || lineText === undefined) {
      return null
    }

    const line = Number.parseInt(lineText, 10)
    return {
      absoluteFilePath,
      end: line,
      start: line,
    }
  }

  return null
}
