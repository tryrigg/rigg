import type { APIRoute } from "astro"
import { renderPng, iconDataUri, BG } from "./_gallery-shared"

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
        fontSize: 16,
        fontFamily: "JetBrains Mono",
        lineHeight: "28px",
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
        fontSize: 16,
        fontFamily: "JetBrains Mono",
        lineHeight: "28px",
        background: bg,
        color: "#1a1a1e",
        padding: "1px 5px",
        fontWeight: 700,
      },
      children: text,
    },
  }
}

function dot(color: string, opts?: { hollow?: boolean; size?: number }) {
  const size = opts?.size ?? 12
  return {
    type: "div",
    props: {
      style: {
        width: size,
        height: size,
        borderRadius: "50%",
        flexShrink: 0,
        ...(opts?.hollow ? { border: `2px solid ${color}` } : { background: color }),
      },
    },
  }
}

function row(...children: unknown[]) {
  return { type: "div", props: { style: { display: "flex", alignItems: "center", minHeight: 28 }, children } }
}

function spacedRow(left: unknown[], right: unknown[]) {
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 28 },
      children: [
        { type: "div", props: { style: { display: "flex", alignItems: "center" }, children: left } },
        { type: "div", props: { style: { display: "flex", alignItems: "center", gap: 8 }, children: right } },
      ],
    },
  }
}

export const GET: APIRoute = async () => {
  const tuiContent = [
    spacedRow(
      [t("  "), t("> ", "#86efac", true), t("rigg", TEXT, true), t(" plan", TEXT, true), t("  3/4 steps", DIM)],
      [t("00:06 ", DIM), t("running", CYAN, true)],
    ),
    { type: "div", props: { style: { height: 1, background: "rgba(255,255,255,0.08)", margin: "3px 16px" } } },
    spacedRow([t("  "), dot(GREEN), t("  draft  ", DIM), t("(codex)", BLUE)], [t("2.3s", DIM)]),
    row(t("  |  Drafted implementation plan for auth module", DIM)),
    row(t("  |", DIM)),
    spacedRow([t("  "), dot(GREEN), t("  critique  ", DIM), t("(claude)", MAGENTA)], [t("1.9s", DIM)]),
    row(t("  |  Found 2 gaps in error handling", DIM)),
    row(t("  |", DIM)),
    spacedRow(
      [t("  "), dot(CYAN), t("  "), inv("refine", CYAN), t("  "), t("(codex)", BLUE)],
      [dot(CYAN, { size: 8 })],
    ),
    row(t("  :  ", DIM), t("Improving draft with critique feedback...")),
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
          type: "span",
          props: {
            style: {
              fontSize: 68,
              fontWeight: 500,
              color: "#111",
              lineHeight: 1.12,
              letterSpacing: "-0.025em",
              marginBottom: 16,
            },
            children: "Runs in your terminal",
          },
        },
        {
          type: "span",
          props: {
            style: { fontSize: 18, color: "#666", fontFamily: "JetBrains Mono", marginBottom: 36 },
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
              borderRadius: 3,
              border: "1px dashed rgba(0,0,0,0.12)",
              overflow: "hidden",
              flex: 1,
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    padding: "10px 18px",
                    borderBottom: "1px solid rgba(255,255,255,0.06)",
                    gap: 7,
                    fontSize: 14,
                    fontFamily: "JetBrains Mono",
                    color: "rgba(255,255,255,0.35)",
                  },
                  children: [
                    { type: "span", props: { children: "~/your-project" } },
                    { type: "span", props: { style: { marginLeft: "auto" }, children: "bash" } },
                  ],
                },
              },
              {
                type: "div",
                props: {
                  style: { display: "flex", flexDirection: "column", padding: "16px 28px 20px" },
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
