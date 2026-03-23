import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import satori from "satori"
import { Resvg } from "@resvg/resvg-js"

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
export const SourceSerifMedium = readFileSync(join(projectRoot, "src/fonts/SourceSerif4-Medium.ttf"))
export const JetBrainsMonoRegular = readFileSync(join(projectRoot, "src/fonts/JetBrainsMono-Regular.ttf"))
const iconPng = readFileSync(join(projectRoot, "public/icon.png"))
export const iconDataUri = `data:image/png;base64,${iconPng.toString("base64")}`

function svgDataUri(name: string): string {
  const svg = readFileSync(join(projectRoot, `public/icons/${name}.svg`))
  return `data:image/svg+xml;base64,${svg.toString("base64")}`
}

export const agentIcons = {
  openai: svgDataUri("openai"),
  claude: svgDataUri("claude"),
  cursor: svgDataUri("cursor"),
}

export const PH_WIDTH = 1270
export const PH_HEIGHT = 760

export const BG = "#f7f6f3"
export const GRADIENT_BG = "linear-gradient(145deg, #f0f5f1 0%, #e8f0ea 50%, #e2ede6 100%)"

export async function renderPng(element: Parameters<typeof satori>[0]): Promise<Response> {
  const svg = await satori(element, {
    width: PH_WIDTH,
    height: PH_HEIGHT,
    fonts: [
      { name: "Source Serif 4", data: SourceSerifMedium, weight: 500, style: "normal" },
      { name: "JetBrains Mono", data: JetBrainsMonoRegular, weight: 400, style: "normal" },
    ],
  })

  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: PH_WIDTH } })
  const png = resvg.render().asPng()

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  })
}
