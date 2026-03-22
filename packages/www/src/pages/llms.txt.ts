import type { APIRoute } from "astro"
import { getCollection } from "astro:content"

const SITE = "https://tryrigg.com"

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

export const GET: APIRoute = async () => {
  const docs = await getCollection("docs")

  const sorted = DOC_ORDER.flatMap((id) => {
    const match = docs.find((d) => d.id === id)
    return match ? [match] : []
  })

  const docLinks = sorted.map((doc) => `- [${doc.data.title}](${SITE}/${doc.id}/): ${doc.data.description}`).join("\n")

  const content = `# Rigg

> Rigg is an open-source, local-first workflow runner for agentic coding. It lets you wire Codex, Cursor, Claude Code, and shell commands into repeatable YAML pipelines that run locally and version in Git.

Rigg captures multi-step agent workflows as \`.rigg/*.yaml\` files in your repository. Instead of ad-hoc prompts and terminal sessions, teams define explicit pipelines for implementation planning, review loops, fix verification, and codebase checks. Every run is recorded under \`.rigg/runs/\`.

Supported agents: Codex (OpenAI), Cursor. Coming soon: Claude Code (Anthropic), opencode, Kimi Code.

Key features:
- YAML-based pipeline definitions with sequential steps, parallel branches, and loops with conditions
- Plain-text Codex run steps and built-in structured Codex review results
- Conditional execution with expression evaluation
- File I/O steps for saving results
- Git-versioned workflows shared across the team

Install: \`curl -fsSL https://tryrigg.com/install | bash\`

Requirements: macOS, \`codex\`, \`cursor\`, and/or \`claude\` on PATH.

## Docs

${docLinks}
- [Full Reference](${SITE}/llms-full.txt): Complete documentation including schema reference and examples

## Optional

- [GitHub Repository](https://github.com/tryrigg/rigg): Source code, issues, and releases
- [Website](${SITE}): Product overview and examples
`

  return new Response(content, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
