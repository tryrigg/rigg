import packageMetadata from "../package.json" with { type: "json" }

declare const RIGG_BUILD_VERSION: string | undefined

function normalizeVersion(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed
}

const packageVersion = normalizeVersion(packageMetadata.version)
const resolvedPackageVersion = packageVersion === "0.0.0" ? undefined : packageVersion

export const RIGG_VERSION =
  (typeof RIGG_BUILD_VERSION !== "undefined" ? normalizeVersion(RIGG_BUILD_VERSION) : undefined) ??
  normalizeVersion(process.env["RIGG_VERSION"]) ??
  resolvedPackageVersion ??
  "dev"
