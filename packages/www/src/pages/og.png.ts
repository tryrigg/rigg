import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import satori from "satori"
import { Resvg } from "@resvg/resvg-js"
import type { APIRoute } from "astro"

const findProjectRoot = () => {
  let currentDir = dirname(fileURLToPath(import.meta.url))
  while (true) {
    if (existsSync(join(currentDir, "astro.config.mjs"))) return currentDir
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) throw new Error(`Failed to locate Astro project root`)
    currentDir = parentDir
  }
}

const projectRoot = findProjectRoot()
const SourceSerifMedium = readFileSync(join(projectRoot, "src/fonts/SourceSerif4-Medium.ttf"))
const JetBrainsMonoRegular = readFileSync(join(projectRoot, "src/fonts/JetBrainsMono-Regular.ttf"))
const iconPng = readFileSync(join(projectRoot, "public/icon.png"))
const iconDataUri = `data:image/png;base64,${iconPng.toString("base64")}`

function svgDataUri(name: string): string {
  const svg = readFileSync(join(projectRoot, `public/icons/${name}.svg`))
  return `data:image/svg+xml;base64,${svg.toString("base64")}`
}

const agentIcons = {
  openai: svgDataUri("openai"),
  claude: svgDataUri("claude"),
  cursor: svgDataUri("cursor"),
}

function statusDot(color: string, hollow = false) {
  return {
    type: "div",
    props: {
      style: {
        width: 12,
        height: 12,
        borderRadius: "50%",
        flexShrink: 0,
        ...(hollow ? { border: `2px solid ${color}`, background: "transparent" } : { background: color }),
      },
    },
  }
}

function flowCard(icon: string, label: string, statusColor: string, meta: string, metaColor = "#999", hollow = false) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 22px",
        background: "white",
        border: "1px solid rgba(0,0,0,0.08)",
        borderRadius: 3,
        fontFamily: "JetBrains Mono",
      },
      children: [
        statusDot(statusColor, hollow),
        { type: "img", props: { src: icon, width: 22, height: 22 } },
        { type: "span", props: { style: { fontSize: 18, fontWeight: 600, color: "#111" }, children: label } },
        { type: "span", props: { style: { fontSize: 15, color: metaColor, marginLeft: 14 }, children: meta } },
      ],
    },
  }
}

function flowGroupCard(tag: string, rows: Array<{ icon: string; label: string; statusColor: string; meta: string }>) {
  return {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "column" as const, gap: 6 },
      children: [
        {
          type: "span",
          props: {
            style: { fontSize: 13, fontWeight: 600, color: "#666", fontFamily: "JetBrains Mono", paddingLeft: 4 },
            children: tag,
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column" as const,
              background: "white",
              border: "1px solid rgba(0,0,0,0.08)",
              borderRadius: 3,
            },
            children: rows.map((r, i) => ({
              type: "div",
              props: {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 22px",
                  fontFamily: "JetBrains Mono",
                  ...(i > 0 ? { borderTop: "1px solid rgba(0,0,0,0.05)" } : {}),
                },
                children: [
                  statusDot(r.statusColor),
                  { type: "img", props: { src: r.icon, width: 22, height: 22 } },
                  {
                    type: "span",
                    props: { style: { fontSize: 18, fontWeight: 600, color: "#111" }, children: r.label },
                  },
                  { type: "span", props: { style: { fontSize: 15, color: "#999", marginLeft: 14 }, children: r.meta } },
                ],
              },
            })),
          },
        },
      ],
    },
  }
}

function connector() {
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", width: 40, flexShrink: 0, padding: "0 4px" },
      children: [
        { type: "div", props: { style: { width: 5, height: 5, borderRadius: "50%", background: "rgba(0,0,0,0.12)" } } },
        { type: "div", props: { style: { flex: 1, height: 1, background: "rgba(0,0,0,0.1)" } } },
        { type: "div", props: { style: { width: 5, height: 5, borderRadius: "50%", background: "rgba(0,0,0,0.12)" } } },
      ],
    },
  }
}

const GREEN = "#16a34a"
const CYAN = "#06b6d4"

export const GET: APIRoute = async () => {
  const image = {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#f7f6f3",
        padding: "56px 72px",
        fontFamily: "Source Serif 4",
        border: "1px dashed rgba(0,0,0,0.08)",
      },
      children: [
        {
          type: "div",
          props: {
            style: { display: "flex", alignItems: "center", gap: 12, marginBottom: 36 },
            children: [
              { type: "img", props: { src: iconDataUri, width: 40, height: 40, style: { borderRadius: 4 } } },
              {
                type: "span",
                props: {
                  style: {
                    fontSize: 28,
                    fontWeight: 500,
                    fontFamily: "JetBrains Mono",
                    color: "#111",
                    letterSpacing: "-0.02em",
                  },
                  children: "Rigg",
                },
              },
            ],
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              fontSize: 68,
              fontWeight: 500,
              color: "#111",
              lineHeight: 1.12,
              letterSpacing: "-0.025em",
              marginBottom: 16,
            },
            children: [
              { type: "span", props: { children: "Local-first workflows" } },
              { type: "span", props: { children: "for agentic coding" } },
            ],
          },
        },
        {
          type: "div",
          props: {
            style: {
              fontSize: 18,
              color: "#666",
              lineHeight: 1.6,
              fontFamily: "JetBrains Mono",
              marginBottom: 36,
            },
            children: "Wire Codex, Claude, and shell commands into repeatable YAML pipelines.",
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: 1,
              background: "linear-gradient(145deg, #f0f5f1 0%, #e8f0ea 50%, #e2ede6 100%)",
              border: "1px dashed rgba(0,0,0,0.06)",
              borderRadius: 3,
              padding: "0 24px",
            },
            children: [
              flowCard(agentIcons.openai, "Review", GREEN, "1.8s"),
              connector(),
              flowGroupCard("Fixes", [
                { icon: agentIcons.claude, label: "error-handling", statusColor: GREEN, meta: "2.1s" },
                { icon: agentIcons.openai, label: "type-safety", statusColor: GREEN, meta: "1.4s" },
                { icon: agentIcons.claude, label: "input-validation", statusColor: GREEN, meta: "0.9s" },
              ]),
              connector(),
              flowCard(agentIcons.cursor, "Verify", CYAN, "running", CYAN, true),
            ],
          },
        },
      ],
    },
  } as Parameters<typeof satori>[0]

  const svg = await satori(image, {
    width: 1200,
    height: 630,
    fonts: [
      { name: "Source Serif 4", data: SourceSerifMedium, weight: 500, style: "normal" },
      { name: "JetBrains Mono", data: JetBrainsMonoRegular, weight: 400, style: "normal" },
    ],
  })

  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
  const png = resvg.render().asPng()

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  })
}
