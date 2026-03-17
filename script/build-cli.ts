#!/usr/bin/env bun

import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..")
const packageRoot = join(repoRoot, "packages", "rigg")
const entrypoint = join(packageRoot, "src", "cli", "bootstrap.ts")
const outfile = join(packageRoot, "dist", "rigg")

function normalizeVersion(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed
}

function runGit(args: string[]): string | undefined {
  if (!existsSync(join(repoRoot, ".git"))) {
    return undefined
  }

  const result = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  })
  if (result.exitCode !== 0) {
    return undefined
  }

  const stdout = Buffer.from(result.stdout).toString("utf8").trim()
  return stdout || undefined
}

function resolveGitVersion(): string | undefined {
  const exactTag = normalizeVersion(runGit(["describe", "--tags", "--exact-match"]))
  if (exactTag) {
    return exactTag
  }

  const nearestTagRef = runGit(["describe", "--tags", "--abbrev=0"])
  const nearestTag = normalizeVersion(nearestTagRef)
  const shortSha = runGit(["rev-parse", "--short", "HEAD"])
  const dirty = Bun.spawnSync(["git", "diff", "--quiet"], {
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  }).exitCode

  if (nearestTagRef && nearestTag && shortSha) {
    const commits = runGit(["rev-list", "--count", `${nearestTagRef}..HEAD`]) ?? "0"
    return `${nearestTag}-dev.${commits}+${shortSha}${dirty === 0 ? "" : ".dirty"}`
  }

  if (shortSha) {
    return `0.0.0-dev+${shortSha}${dirty === 0 ? "" : ".dirty"}`
  }

  return undefined
}

async function resolveBuildVersion(): Promise<string> {
  const packageMetadata = (await Bun.file(join(packageRoot, "package.json")).json()) as { version?: string }
  return (
    normalizeVersion(process.env.RIGG_VERSION) ??
    (() => {
      const version = normalizeVersion(packageMetadata.version)
      return version && version !== "0.0.0" ? version : undefined
    })() ??
    resolveGitVersion() ??
    "dev"
  )
}

const version = await resolveBuildVersion()

await mkdir(dirname(outfile), { recursive: true })

const result = await Bun.build({
  entrypoints: [entrypoint],
  compile: {
    outfile,
  },
  define: {
    RIGG_BUILD_VERSION: JSON.stringify(version),
    // Bun must see DEV as false at build time so Ink's optional React DevTools path
    // is removed from the compiled standalone binary.
    "process.env.DEV": JSON.stringify("false"),
  },
  env: "disable",
  autoloadDotenv: false,
  autoloadBunfig: false,
  autoloadPackageJson: false,
  autoloadTsconfig: false,
})

if (!result.success) {
  const message = result.logs.map((log) => log.message).join("\n")
  throw new Error(message || "bun build failed")
}

console.log(`built rigg ${version} -> ${outfile}`)
