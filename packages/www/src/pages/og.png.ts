import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import satori from "satori"
import { Resvg } from "@resvg/resvg-js"
import type { APIRoute } from "astro"

const findProjectRoot = () => {
  let currentDir = dirname(fileURLToPath(import.meta.url))

  while (true) {
    if (existsSync(join(currentDir, "astro.config.mjs"))) {
      return currentDir
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      throw new Error(`Failed to locate Astro project root for ${import.meta.url}`)
    }

    currentDir = parentDir
  }
}

const projectRoot = findProjectRoot()
const InterBold = readFileSync(join(projectRoot, "src/fonts/Inter-Bold.ttf"))
const JetBrainsMonoRegular = readFileSync(join(projectRoot, "src/fonts/JetBrainsMono-Regular.ttf"))
const iconPng = readFileSync(join(projectRoot, "public/icon.png"))
const iconDataUri = `data:image/png;base64,${iconPng.toString("base64")}`

export const GET: APIRoute = async () => {
  const svg = await satori(
    {
      type: "div",
      props: {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          backgroundColor: "#fafafa",
          padding: "0px 88px",
          paddingBottom: "24px",
          fontFamily: "Inter",
        },
        children: [
          // Logo
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                alignItems: "center",
                gap: "18px",
                marginBottom: "48px",
              },
              children: [
                {
                  type: "img",
                  props: {
                    src: iconDataUri,
                    width: 56,
                    height: 56,
                    style: {
                      borderRadius: "12px",
                    },
                  },
                },
                {
                  type: "span",
                  props: {
                    style: {
                      fontSize: "40px",
                      fontWeight: 700,
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
          // Headline
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                flexDirection: "column",
                fontSize: "68px",
                fontWeight: 700,
                color: "#111",
                lineHeight: 1.12,
                letterSpacing: "-0.035em",
                marginBottom: "28px",
              },
              children: [
                {
                  type: "span",
                  props: { children: "Local-first workflows for" },
                },
                {
                  type: "span",
                  props: { children: "agentic coding" },
                },
              ],
            },
          },
          // Subtitle
          {
            type: "div",
            props: {
              style: {
                fontSize: "26px",
                color: "#666",
                lineHeight: 1.5,
              },
              children: "Wire Codex, Claude, and shell commands into repeatable YAML pipelines.",
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: "Inter",
          data: InterBold,
          weight: 700,
          style: "normal",
        },
        {
          name: "JetBrains Mono",
          data: JetBrainsMonoRegular,
          weight: 400,
          style: "normal",
        },
      ],
    },
  )

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
  })
  const png = resvg.render().asPng()

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  })
}
