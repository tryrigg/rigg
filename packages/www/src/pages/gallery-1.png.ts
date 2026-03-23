import type { APIRoute } from "astro"
import { renderPng, iconDataUri, agentIcons, BG, GRADIENT_BG } from "./_gallery-shared"

const GREEN = "#16a34a"
const CYAN = "#06b6d4"

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

export const GET: APIRoute = async () => {
  const image = {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: BG,
        padding: "56px 72px",
        fontFamily: "Source Serif 4",
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
            style: { fontSize: 18, color: "#666", lineHeight: 1.6, fontFamily: "JetBrains Mono", marginBottom: 36 },
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
              backgroundImage: GRADIENT_BG,
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
  } as Parameters<typeof import("satori").default>[0]

  return renderPng(image)
}
