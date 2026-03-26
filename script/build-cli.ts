#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..")
const packageRoot = join(repoRoot, "packages", "rigg")
const drizzleDir = join(packageRoot, "drizzle")
const distDir = join(packageRoot, "dist")
const entrypoint = join(packageRoot, "src", "cli", "bootstrap.ts")
const outfile = join(distDir, "rigg")

type DrizzleJournal = {
  entries: {
    breakpoints: boolean
    idx: number
    tag: string
    when: number
  }[]
}

type BundledMigration = {
  bps: boolean
  folderMillis: number
  hash: string
  sql: string[]
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function readVersion(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function parsePackageJson(value: unknown): { version?: string } {
  const json = record(value)
  if (json === null) {
    throw new Error(`failed to parse package metadata: expected object in ${join(packageRoot, "package.json")}`)
  }

  return { version: readVersion(json.version) }
}

function parseJournalEntry(value: unknown, path: string): DrizzleJournal["entries"][number] {
  const entry = record(value)
  if (entry === null) {
    throw new Error(`failed to parse migration journal entry in ${path}: expected object`)
  }

  if (typeof entry.breakpoints !== "boolean") {
    throw new Error(`failed to parse migration journal entry in ${path}: "breakpoints" must be boolean`)
  }
  if (typeof entry.idx !== "number") {
    throw new Error(`failed to parse migration journal entry in ${path}: "idx" must be number`)
  }
  if (typeof entry.tag !== "string") {
    throw new Error(`failed to parse migration journal entry in ${path}: "tag" must be string`)
  }
  if (typeof entry.when !== "number") {
    throw new Error(`failed to parse migration journal entry in ${path}: "when" must be number`)
  }

  return {
    breakpoints: entry.breakpoints,
    idx: entry.idx,
    tag: entry.tag,
    when: entry.when,
  }
}

function parseJournal(value: unknown, path: string): DrizzleJournal {
  const json = record(value)
  if (json === null) {
    throw new Error(`failed to parse migration journal: expected object in ${path}`)
  }
  if (!Array.isArray(json.entries)) {
    throw new Error(`failed to parse migration journal: "entries" must be an array in ${path}`)
  }

  return {
    entries: json.entries.map((entry) => parseJournalEntry(entry, path)),
  }
}

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
  const packageMetadata = parsePackageJson(await Bun.file(join(packageRoot, "package.json")).json())
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

async function loadBundledMigrations(): Promise<BundledMigration[]> {
  const path = join(drizzleDir, "meta", "_journal.json")
  const journal = parseJournal(JSON.parse(await readFile(path, "utf8")) as unknown, path)

  return await Promise.all(
    [...journal.entries]
      .sort((left, right) => left.idx - right.idx)
      .map(async (entry) => {
        const sql = await readFile(join(drizzleDir, `${entry.tag}.sql`), "utf8")
        return {
          bps: entry.breakpoints,
          folderMillis: entry.when,
          hash: createHash("sha256").update(sql).digest("hex"),
          sql: sql.split("--> statement-breakpoint"),
        }
      }),
  )
}

const version = await resolveBuildVersion()
const bundledMigrations = await loadBundledMigrations()

await rm(distDir, { force: true, recursive: true })
await mkdir(dirname(outfile), { recursive: true })

const result = await Bun.build({
  entrypoints: [entrypoint],
  compile: {
    outfile,
  },
  define: {
    RIGG_BUILD_VERSION: JSON.stringify(version),
    RIGG_BUNDLED_MIGRATIONS: JSON.stringify(bundledMigrations),
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

console.log(`built rigg ${version} -> ${outfile} (${bundledMigrations.length} bundled migrations)`)
