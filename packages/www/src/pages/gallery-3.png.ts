import type { APIRoute } from "astro"
import { renderPng, iconDataUri, GRADIENT_BG } from "./_gallery-shared"

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
        fontSize: 17,
        fontFamily: "JetBrains Mono",
        lineHeight: "30px",
        whiteSpace: "pre" as const,
        color,
        ...(bold ? { fontWeight: 700 } : {}),
      },
      children: text,
    },
  }
}

function row(...children: unknown[]) {
  return { type: "div", props: { style: { display: "flex", minHeight: 30 }, children } }
}

function diffRow(text: string) {
  return {
    type: "div",
    props: {
      style: { display: "flex", minHeight: 30, background: DIFF_BG, borderRadius: 2, margin: "1px 0", paddingLeft: 4 },
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
        borderRadius: 12,
        overflow: "hidden",
        boxShadow: "0 4px 20px rgba(0,0,0,0.2)",
        flex: flexVal,
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 18px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            },
            children: [
              {
                type: "div",
                props: { style: { width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.08)" } },
              },
              {
                type: "div",
                props: { style: { width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.08)" } },
              },
              {
                type: "div",
                props: { style: { width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.08)" } },
              },
              {
                type: "span",
                props: {
                  style: { marginLeft: 8, fontSize: 14, color: "rgba(255,255,255,0.35)", fontFamily: "JetBrains Mono" },
                  children: title,
                },
              },
            ],
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "column", padding: "20px 24px" },
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
    row(t("@@ -0,0 +1,14 @@", "#6e7681")),
    diffRow("+id: review"),
    diffRow("+steps:"),
    diffRow("+  - id: scan"),
    diffRow("+    type: codex"),
    diffRow("+    with:"),
    diffRow("+      action: review"),
    diffRow("+  - id: fix"),
    diffRow("+    if: ${{ len(steps.scan.result.findings) > 0 }}"),
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
            children: "Version in Git. Share with your team.",
          },
        },
        {
          type: "span",
          props: {
            style: { fontSize: 20, color: "#666", marginTop: 8 },
            children: "Drop .rigg/*.yaml into your repo. Review workflows in PRs like code.",
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", gap: 20, marginTop: 24, flex: 1 },
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
