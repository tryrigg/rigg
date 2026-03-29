import type { APIRoute } from "astro"
import { renderPng, agentIcons, BG } from "./_gallery-shared"

const CYAN = "#06b6d4"
const ORANGE = "#f59e0b"
const PARENT_COLOR = "#6366f1"

function stepRow(icons: string[], label: string) {
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", gap: 8, minHeight: 30 },
      children: [
        ...icons.map((icon) => ({
          type: "img",
          props: { src: icon, width: 18, height: 18 },
        })),
        {
          type: "span",
          props: {
            style: { fontSize: 14, color: "#555", fontFamily: "JetBrains Mono" },
            children: label,
          },
        },
      ],
    },
  }
}

function shellStep(label: string) {
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", gap: 8, minHeight: 30 },
      children: [
        {
          type: "div",
          props: {
            style: {
              width: 18,
              height: 18,
              borderRadius: 3,
              background: "#e5e7eb",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontFamily: "JetBrains Mono",
              color: "#666",
              fontWeight: 600,
            },
            children: "$",
          },
        },
        {
          type: "span",
          props: {
            style: { fontSize: 14, color: "#555", fontFamily: "JetBrains Mono" },
            children: label,
          },
        },
      ],
    },
  }
}

function badge(text: string, color: string) {
  return {
    type: "span",
    props: {
      style: {
        fontSize: 11,
        color,
        fontFamily: "JetBrains Mono",
        background: `${color}15`,
        padding: "3px 8px",
        borderRadius: 3,
      },
      children: text,
    },
  }
}

function workflowCard(name: string, steps: unknown[], badges: unknown[]) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column" as const,
        background: "white",
        border: "1px solid rgba(0,0,0,0.1)",
        borderRadius: 5,
        padding: "16px 18px",
        gap: 5,
        flex: 1,
        minWidth: 0,
      },
      children: [
        {
          type: "span",
          props: {
            style: {
              fontSize: 15,
              fontWeight: 600,
              color: "#111",
              fontFamily: "JetBrains Mono",
              marginBottom: 4,
            },
            children: name,
          },
        },
        ...steps,
        ...(badges.length > 0
          ? [
              {
                type: "div",
                props: {
                  style: { display: "flex", gap: 6, paddingTop: 6 },
                  children: badges,
                },
              },
            ]
          : []),
      ],
    },
  }
}

function parentThinking(labels: string[]) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center",
        justifyContent: "center",
        width: 110,
        flexShrink: 0,
        gap: 4,
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              width: "100%",
              gap: 6,
            },
            children: [
              {
                type: "div",
                props: {
                  style: { flex: 1, height: 0, borderTop: `2px dashed ${PARENT_COLOR}35` },
                },
              },
              {
                type: "div",
                props: {
                  style: {
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: `${PARENT_COLOR}20`,
                    border: `2px solid ${PARENT_COLOR}60`,
                    flexShrink: 0,
                  },
                },
              },
              {
                type: "div",
                props: {
                  style: { flex: 1, height: 0, borderTop: `2px dashed ${PARENT_COLOR}35` },
                },
              },
            ],
          },
        },
        ...labels.map((label) => ({
          type: "span",
          props: {
            style: {
              fontSize: 11,
              color: PARENT_COLOR,
              fontFamily: "JetBrains Mono",
              whiteSpace: "nowrap" as const,
            },
            children: label,
          },
        })),
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
        flexDirection: "column" as const,
        backgroundColor: BG,
        padding: "36px 56px",
        fontFamily: "Source Serif 4",
        justifyContent: "center",
      },
      children: [
        {
          type: "span",
          props: {
            style: {
              fontSize: 40,
              fontWeight: 500,
              color: "#111",
              letterSpacing: "-0.025em",
              marginBottom: 24,
            },
            children: "Small workflows, one parent agent",
          },
        },

        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column" as const,
              border: `1.5px solid ${PARENT_COLOR}30`,
              borderRadius: 8,
              overflow: "hidden",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "10px 20px",
                    background: `${PARENT_COLOR}08`,
                    borderBottom: `1px solid ${PARENT_COLOR}18`,
                  },
                  children: [
                    {
                      type: "img",
                      props: { src: agentIcons.claude, width: 18, height: 18 },
                    },
                    {
                      type: "span",
                      props: {
                        style: {
                          fontSize: 14,
                          color: PARENT_COLOR,
                          fontFamily: "JetBrains Mono",
                          fontWeight: 600,
                        },
                        children: "Parent Agent (Claude Code)",
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
                    alignItems: "center",
                    padding: "20px 16px",
                    gap: 0,
                  },
                  children: [
                    workflowCard(
                      "UX Design",
                      [
                        stepRow([agentIcons.claude], "explore"),
                        stepRow([agentIcons.claude, agentIcons.openai], "design"),
                        stepRow([agentIcons.claude], "synthesize"),
                      ],
                      [badge("approve", ORANGE)],
                    ),
                    parentThinking(["evaluate", "approve"]),
                    workflowCard(
                      "Plan",
                      [
                        stepRow([agentIcons.cursor], "explore"),
                        stepRow([agentIcons.openai], "draft"),
                        stepRow([agentIcons.claude], "audit"),
                        stepRow([agentIcons.openai], "refine"),
                      ],
                      [badge("approve", ORANGE)],
                    ),
                    parentThinking(["evaluate", "approve"]),
                    workflowCard(
                      "Implement",
                      [stepRow([agentIcons.openai], "code"), shellStep("verify")],
                      [badge("loop max 5", CYAN)],
                    ),
                    parentThinking(["pass context"]),
                    workflowCard(
                      "Review",
                      [
                        stepRow([agentIcons.openai], "review"),
                        stepRow([agentIcons.claude], "triage"),
                        stepRow([agentIcons.openai], "fix"),
                        stepRow([agentIcons.cursor], "validate"),
                      ],
                      [badge("loop max 6", CYAN)],
                    ),
                    parentThinking(["pass context"]),
                    workflowCard(
                      "Refactor",
                      [stepRow([agentIcons.openai], "refactor"), stepRow([agentIcons.claude], "simplify")],
                      [badge("loop", CYAN)],
                    ),
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  } as Parameters<typeof import("satori").default>[0]

  return renderPng(image, { width: 1400, height: 520 })
}
