import type { APIRoute } from "astro"
import { renderPng, iconDataUri, BG } from "./_gallery-shared"

const TEXT = "#c9d1d9"
const DIM = "rgba(255,255,255,0.3)"
const GREEN = "#86efac"
const ACCENT = "#fbbf24"
const DIFF_BG = "#2ea04330"
const DIFF_TEXT = "#7ee787"
const DIFF_HEADER = "#888"

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

function row(...children: unknown[]) {
  return { type: "div", props: { style: { display: "flex", minHeight: 28 }, children } }
}

function diffRow(text: string) {
  return {
    type: "div",
    props: {
      style: { display: "flex", minHeight: 28, background: DIFF_BG, margin: "1px 0", paddingLeft: 4 },
      children: [t(text, DIFF_TEXT)],
    },
  }
}

function codePanel(title: string, lines: unknown[], flexVal = 1) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column" as const,
        background: "#1a1a1e",
        borderRadius: 3,
        border: "1px dashed rgba(0,0,0,0.12)",
        overflow: "hidden",
        flex: flexVal,
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "10px 18px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            },
            children: [
              {
                type: "span",
                props: {
                  style: { fontSize: 14, color: "rgba(255,255,255,0.35)", fontFamily: "JetBrains Mono" },
                  children: title,
                },
              },
            ],
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "column", padding: "16px 20px" },
            children: lines,
          },
        },
      ],
    },
  }
}

export const GET: APIRoute = async () => {
  const treeLines = [
    row(t("your-project/", DIM)),
    row(t("|-- ", DIM), t(".rigg/", ACCENT, true)),
    row(t("|   |-- ", DIM), t("plan.yaml", GREEN)),
    row(t("|   |-- ", DIM), t("review.yaml", GREEN)),
    row(t("|   '-- ", DIM), t("parallel-checks.yaml", GREEN)),
    row(t("|-- ", DIM), t("src/")),
    row(t("|-- ", DIM), t("package.json")),
    row(t("'-- ", DIM), t("...")),
  ]

  const diffLines = [
    row(t("diff --git a/.rigg/review.yaml", DIFF_HEADER)),
    row(t("new file mode 100644", DIFF_HEADER)),
    row(t("--- /dev/null", DIFF_HEADER)),
    row(t("+++ b/.rigg/review.yaml", DIFF_HEADER)),
    row(t("@@ -0,0 +1,12 @@", "#6e7681")),
    diffRow("+id: review"),
    diffRow("+steps:"),
    diffRow("+  - id: scan"),
    diffRow("+    type: codex"),
    diffRow("+    with:"),
    diffRow("+      action: review"),
    diffRow("+  - id: fix"),
    diffRow("+    if: ${{ ... }}"),
    diffRow("+    type: codex"),
    diffRow("+    with:"),
    diffRow("+      action: run"),
    diffRow("+      prompt: Fix all findings"),
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
            children: "Version in Git. Share with your team.",
          },
        },
        {
          type: "span",
          props: {
            style: { fontSize: 18, color: "#666", fontFamily: "JetBrains Mono", marginBottom: 36 },
            children: "Drop .rigg/*.yaml into your repo. Review workflows in PRs.",
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", gap: 16, flex: 1 },
            children: [
              codePanel("project structure", treeLines, 1),
              codePanel("git diff -- .rigg/review.yaml", diffLines, 1.5),
            ],
          },
        },
      ],
    },
  } as Parameters<typeof import("satori").default>[0]

  return renderPng(image)
}
