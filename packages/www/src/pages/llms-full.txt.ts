import type { APIRoute } from "astro"
import { getCollection } from "astro:content"

const DOC_ORDER = [
  "docs",
  "docs/workflows",
  "docs/workflows/steps",
  "docs/workflows/control-flow",
  "docs/workflows/expressions",
  "docs/workflows/conversations",
  "docs/reference/schema",
  "docs/reference/cli",
  "docs/examples",
]

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
}

export const GET: APIRoute = async () => {
  const docs = await getCollection("docs")

  const sorted = DOC_ORDER.flatMap((orderedId) => {
    const match = docs.find((d) => d.id === orderedId)
    return match ? [match] : []
  })

  const sections = sorted.map((doc) => {
    const body = decodeEntities(doc.body ?? "")
    return `## ${doc.data.title}\n\n${body.trim()}`
  })

  const content = `# Rigg

> Rigg is an open-source, local-first workflow runner for agentic coding. It lets you wire Codex, Claude Code, Cursor, OpenCode, and shell commands into repeatable YAML pipelines that run locally and version in Git.

As more engineering work moves into local AI agents, teams need a way to turn the good repetitive parts of their day-to-day workflow into something explicit and reusable: implementation planning, review loops, fix verification, codebase checks, and other multi-step flows that are usually done ad hoc in prompts and terminals.

Rigg lets you capture those workflows as \`.rigg/*.yaml\`, run them locally with tools like Codex, Claude Code, Cursor, and OpenCode, and keep them in Git alongside the code they operate on. That makes agent workflows easier to review, share, standardize, and evolve as a team, instead of living as private prompt habits.

The goal is to help teams use local coding agents in a safer and more repeatable way: common workflows are versioned, execution is visible, and local run history is available through commands like \`rigg history\`, \`rigg show\`, and \`rigg logs\` when the history database is available.

${sections.join("\n\n")}

## Links

- Website: https://tryrigg.com
- GitHub: https://github.com/tryrigg/rigg
`

  return new Response(content, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
