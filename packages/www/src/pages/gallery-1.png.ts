import type { APIRoute } from "astro"
import { renderPng, iconDataUri, agentIcons, GRADIENT_BG } from "./_gallery-shared"

const AGENT_COLORS: Record<string, string> = {
  codex: "#3b82f6",
  claude: "#d97757",
  cursor: "#555",
}

function agentCard(
  icon: string,
  name: string,
  agentType: string,
  statusColor: string,
  detail: string,
  running = false,
) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: "32px 44px 28px",
        background: "white",
        borderRadius: 16,
        boxShadow: "0 2px 12px rgba(0,0,0,0.07)",
        minWidth: 190,
        gap: 6,
      },
      children: [
        {
          type: "img",
          props: { src: icon, width: 52, height: 52, style: { marginBottom: 14 } },
        },
        {
          type: "span",
          props: {
            style: { fontSize: 20, fontWeight: 700, color: "#111", fontFamily: "JetBrains Mono" },
            children: name,
          },
        },
        {
          type: "span",
          props: {
            style: { fontSize: 15, color: AGENT_COLORS[agentType] ?? "#999", fontFamily: "JetBrains Mono" },
            children: agentType,
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", alignItems: "center", gap: 6, marginTop: 8 },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    background: statusColor,
                    flexShrink: 0,
                    ...(running ? { boxShadow: `0 0 0 3px ${statusColor}33` } : {}),
                  },
                },
              },
              {
                type: "span",
                props: {
                  style: { fontSize: 15, color: running ? statusColor : "#999", fontFamily: "JetBrains Mono" },
                  children: detail,
                },
              },
            ],
          },
        },
      ],
    },
  }
}

function groupCard(
  title: string,
  items: Array<{ icon: string; name: string; agentType: string; statusColor: string; detail: string }>,
) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column" as const,
        padding: "24px 32px",
        background: "white",
        borderRadius: 16,
        boxShadow: "0 2px 12px rgba(0,0,0,0.07)",
        minWidth: 300,
      },
      children: [
        {
          type: "span",
          props: {
            style: {
              fontSize: 14,
              fontWeight: 700,
              color: "#888",
              marginBottom: 18,
              letterSpacing: "0.04em",
              textTransform: "uppercase" as const,
              fontFamily: "JetBrains Mono",
            },
            children: title,
          },
        },
        ...items.map((item, i) => ({
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 12,
              ...(i > 0 ? { marginTop: 14 } : {}),
            },
            children: [
              { type: "img", props: { src: item.icon, width: 30, height: 30, style: { flexShrink: 0 } } },
              {
                type: "span",
                props: {
                  style: { fontSize: 18, fontWeight: 700, color: "#111", fontFamily: "JetBrains Mono", flex: 1 },
                  children: item.name,
                },
              },
              {
                type: "div",
                props: {
                  style: { width: 12, height: 12, borderRadius: "50%", background: item.statusColor, flexShrink: 0 },
                },
              },
              {
                type: "span",
                props: {
                  style: { fontSize: 15, color: "#999", fontFamily: "JetBrains Mono" },
                  children: item.detail,
                },
              },
            ],
          },
        })),
      ],
    },
  }
}

function connector() {
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", justifyContent: "center", width: 56, flexShrink: 0 },
      children: [
        {
          type: "div",
          props: { style: { width: 8, height: 8, borderRadius: "50%", background: "rgba(0,0,0,0.12)", flexShrink: 0 } },
        },
        { type: "div", props: { style: { flex: 1, height: 2, background: "rgba(0,0,0,0.08)" } } },
        {
          type: "div",
          props: { style: { width: 8, height: 8, borderRadius: "50%", background: "rgba(0,0,0,0.12)", flexShrink: 0 } },
        },
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
        backgroundImage: GRADIENT_BG,
        padding: "44px 64px",
        fontFamily: "JetBrains Mono",
      },
      children: [
        {
          type: "div",
          props: {
            style: { display: "flex", alignItems: "center", gap: 10 },
            children: [
              { type: "img", props: { src: iconDataUri, width: 32, height: 32, style: { borderRadius: 6 } } },
              {
                type: "span",
                props: {
                  style: { fontSize: 24, fontWeight: 700, color: "#111", letterSpacing: "-0.02em" },
                  children: "Rigg",
                },
              },
            ],
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "column", marginTop: 20 },
            children: [
              {
                type: "span",
                props: {
                  style: {
                    fontSize: 54,
                    fontWeight: 700,
                    fontFamily: "Inter",
                    color: "#111",
                    lineHeight: 1.12,
                    letterSpacing: "-0.035em",
                  },
                  children: "Local-first workflows",
                },
              },
              {
                type: "span",
                props: {
                  style: {
                    fontSize: 54,
                    fontWeight: 700,
                    fontFamily: "Inter",
                    color: "#111",
                    lineHeight: 1.12,
                    letterSpacing: "-0.035em",
                  },
                  children: "for agentic coding",
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
              fontSize: 18,
              color: "#666",
              lineHeight: 1.5,
              fontFamily: "JetBrains Mono",
              marginTop: 8,
            },
            children: [
              { type: "span", props: { children: "Wire Codex, Claude, and Cursor into repeatable YAML pipelines." } },
              { type: "span", props: { children: "Run locally, version in Git, share with your team." } },
            ],
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
              width: "100%",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "stretch",
                    justifyContent: "center",
                    background: "rgba(255, 255, 255, 0.25)",
                    border: "1px solid rgba(255, 255, 255, 0.45)",
                    borderRadius: 20,
                    boxShadow: "0 8px 32px rgba(0,0,0,0.05)",
                    padding: "32px 40px",
                    width: "100%",
                  },
                  children: [
                    agentCard(agentIcons.openai, "Review", "codex", "#16a34a", "1.8s"),
                    connector(),
                    groupCard("Fixes", [
                      {
                        icon: agentIcons.claude,
                        name: "fix-auth",
                        agentType: "claude",
                        statusColor: "#16a34a",
                        detail: "2.1s",
                      },
                      {
                        icon: agentIcons.openai,
                        name: "fix-types",
                        agentType: "codex",
                        statusColor: "#16a34a",
                        detail: "1.4s",
                      },
                      {
                        icon: agentIcons.claude,
                        name: "fix-perf",
                        agentType: "claude",
                        statusColor: "#16a34a",
                        detail: "0.8s",
                      },
                    ]),
                    connector(),
                    agentCard(agentIcons.cursor, "Verify", "cursor", "#06b6d4", "running", true),
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  } as Parameters<typeof import("satori").default>[0]

  return renderPng(image)
}
