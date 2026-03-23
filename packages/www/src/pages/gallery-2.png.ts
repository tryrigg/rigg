import type { APIRoute } from "astro"
import { renderPng, iconDataUri, GRADIENT_BG } from "./_gallery-shared"

const GREEN = "#16a34a"
const CYAN = "#06b6d4"
const BLUE = "#3b82f6"
const MAGENTA = "#a855f7"
const DIM = "rgba(255,255,255,0.28)"
const TEXT = "#c9d1d9"

function t(text: string, color = TEXT, bold = false) {
  return {
    type: "span",
    props: {
      style: {
        fontSize: 17,
        fontFamily: "JetBrains Mono",
        lineHeight: "32px",
        whiteSpace: "pre" as const,
        color,
        ...(bold ? { fontWeight: 700 } : {}),
      },
      children: text,
    },
  }
}

function inv(text: string, bg: string) {
  return {
    type: "span",
    props: {
      style: {
        fontSize: 17,
        fontFamily: "JetBrains Mono",
        lineHeight: "32px",
        background: bg,
        color: "#1a1a1e",
        padding: "2px 6px",
        borderRadius: 3,
        fontWeight: 700,
      },
      children: text,
    },
  }
}

function dot(color: string, opts?: { hollow?: boolean; glow?: boolean; size?: number }) {
  const size = opts?.size ?? 16
  return {
    type: "div",
    props: {
      style: {
        width: size,
        height: size,
        borderRadius: "50%",
        flexShrink: 0,
        ...(opts?.hollow ? { border: `2px solid ${color}` } : { background: color }),
        ...(opts?.glow ? { boxShadow: `0 0 0 3px ${color}33` } : {}),
      },
    },
  }
}

function row(...children: unknown[]) {
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", minHeight: 32 },
      children,
    },
  }
}

function spacedRow(left: unknown[], right: unknown[]) {
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 32 },
      children: [
        { type: "div", props: { style: { display: "flex", alignItems: "center" }, children: left } },
        { type: "div", props: { style: { display: "flex", alignItems: "center", gap: 8 }, children: right } },
      ],
    },
  }
}

function ruleLine() {
  return {
    type: "div",
    props: {
      style: {
        marginLeft: 16,
        marginRight: 16,
        height: 1,
        background: "rgba(255,255,255,0.08)",
        minHeight: 1,
        marginTop: 4,
        marginBottom: 4,
      },
    },
  }
}

export const GET: APIRoute = async () => {
  const tuiContent = [
    spacedRow(
      [t("  "), t("> ", "#86efac", true), t("rigg", TEXT, true), t(" plan", TEXT, true), t("  3/4 steps", DIM)],
      [t("6.1s ", DIM), t("running", CYAN, true)],
    ),
    ruleLine(),
    spacedRow([t("  "), dot(GREEN), t("  draft  ", DIM), t("(codex)", BLUE)], [t("2.3s", DIM)]),
    row(t("  |  | Drafted implementation plan for auth module", DIM)),
    row(t("  |", DIM)),
    spacedRow([t("  "), dot(GREEN), t("  critique  ", DIM), t("(claude)", MAGENTA)], [t("1.9s", DIM)]),
    row(t("  |  | Found 2 gaps in error handling", DIM)),
    row(t("  |", DIM)),
    spacedRow(
      [t("  "), dot(CYAN, { glow: true }), t("  "), inv("refine", CYAN), t("  "), t("(codex)", BLUE)],
      [dot(CYAN, { size: 10 })],
    ),
    row(t("  |  | Improving draft with critique feedback...")),
    row(t("  |", DIM)),
    row(t("  "), dot("#666", { hollow: true }), t("  save  ", DIM), t("(write_file)", MAGENTA)),
    row(t("     -> PLAN.md", DIM)),
  ]

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
          type: "span",
          props: {
            style: {
              fontSize: 48,
              fontWeight: 700,
              fontFamily: "Inter",
              color: "#111",
              lineHeight: 1.15,
              letterSpacing: "-0.035em",
              marginTop: 20,
            },
            children: "Runs in your terminal",
          },
        },
        {
          type: "span",
          props: {
            style: { fontSize: 20, color: "#666", marginTop: 8 },
            children: "No cloud, no browser. One command to run any workflow.",
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              background: "#1a1a1e",
              borderRadius: 12,
              overflow: "hidden",
              boxShadow: "0 16px 64px rgba(0,0,0,0.25)",
              width: "100%",
              marginTop: 24,
              flex: 1,
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    padding: "12px 18px",
                    background: "#252528",
                    gap: 8,
                  },
                  children: [
                    {
                      type: "div",
                      props: { style: { width: 12, height: 12, borderRadius: "50%", background: "#ff5f57" } },
                    },
                    {
                      type: "div",
                      props: { style: { width: 12, height: 12, borderRadius: "50%", background: "#febc2e" } },
                    },
                    {
                      type: "div",
                      props: { style: { width: 12, height: 12, borderRadius: "50%", background: "#28c840" } },
                    },
                    {
                      type: "span",
                      props: {
                        style: { flex: 1, textAlign: "center" as const, fontSize: 13, color: "rgba(255,255,255,0.4)" },
                        children: "Terminal",
                      },
                    },
                    { type: "div", props: { style: { width: 44 } } },
                  ],
                },
              },
              {
                type: "div",
                props: {
                  style: { display: "flex", flexDirection: "column", padding: "24px 32px 28px" },
                  children: tuiContent,
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
