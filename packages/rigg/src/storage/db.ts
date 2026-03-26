import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

import { Database } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"

import { normalizeError } from "../util/error"
import { schema } from "./schema"

declare const RIGG_BUNDLED_MIGRATIONS: Migration[] | undefined

const DEFAULT_DB_NAME = "rigg.db"
const DEFAULT_DATA_DIR = ".local/share/rigg"
const TEMP_SCOPE = Bun.randomUUIDv7()

export type Db = BunSQLiteDatabase<typeof schema> & { $client: Database }
export type Tx = Parameters<Db["transaction"]>[0] extends (tx: infer T) => unknown ? T : never
export type Conn = Db | Tx
export type OpenDbResult = { kind: "ok"; db: Db } | { kind: "disabled"; warning: string[] }

type Opts = {
  env?: Record<string, string | undefined>
  migrationsFolder?: string
}

type Migration = {
  bps: boolean
  folderMillis: number
  hash: string
  sql: string[]
}

type Source =
  | { kind: "bundled"; migrations: Migration[] }
  | { kind: "folder"; path: string }
  | { kind: "missing"; path: string }
type OpenResult =
  | { kind: "ok"; db: Db }
  | { kind: "open_failed"; err: unknown }
  | { kind: "migrate_failed"; err: unknown }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function migrateBundled(db: Db, migrations: Migration[]): void {
  const value = record(db)
  if (value === null) {
    throw new Error("failed to run bundled migrations: invalid database handle")
  }

  const dialect = record(value["dialect"])
  if (dialect === null || typeof dialect["migrate"] !== "function") {
    throw new Error("failed to run bundled migrations: drizzle dialect does not expose migrate()")
  }

  const session = value["session"]
  Reflect.apply(dialect["migrate"], dialect, [migrations, session])
}

function applyPragmas(db: Database) {
  db.run("PRAGMA journal_mode = WAL;")
  db.run("PRAGMA synchronous = NORMAL;")
  db.run("PRAGMA busy_timeout = 5000;")
  db.run("PRAGMA cache_size = -64000;")
  db.run("PRAGMA foreign_keys = ON;")
  db.run("PRAGMA wal_checkpoint(PASSIVE);")
}

function openClient(path: string) {
  return new Database(path, { create: true, readwrite: true, strict: true })
}

function createDb(path: string) {
  const client = openClient(path)
  applyPragmas(client)
  const db: Db = drizzle(client, { schema })
  return db
}

export function resolveDbPath(env: Record<string, string | undefined> = process.env) {
  const xdg = env["XDG_DATA_HOME"]?.trim()
  if (xdg) {
    return resolve(xdg, "rigg", DEFAULT_DB_NAME)
  }

  const home = env["HOME"]?.trim()
  if (!home) {
    return resolve(tmpdir(), "rigg", TEMP_SCOPE, DEFAULT_DB_NAME)
  }

  return resolve(home, DEFAULT_DATA_DIR, DEFAULT_DB_NAME)
}

function resolveFolder(dir?: string) {
  if (dir) {
    return dir
  }

  const src = resolve(import.meta.dir, "..", "..", "drizzle")
  if (existsSync(src)) {
    return src
  }

  return resolve(dirname(process.execPath), "drizzle")
}

function openWarning(err: unknown, path: string) {
  const msg = normalizeError(err).message
  const lower = msg.toLowerCase()

  if (lower.includes("database is locked") || lower.includes("database locked")) {
    return [
      "⚠ Run history unavailable: database locked",
      "  Runs will still execute but this run will not be recorded.",
    ]
  }

  if (lower.includes("disk") && lower.includes("full")) {
    return ["⚠ Could not write run history: disk full", "  Runs will still execute but history will not be recorded."]
  }

  if (lower.includes("permission") || lower.includes("readonly")) {
    return [
      `⚠ Could not create run history database: permission denied at ${path}`,
      "  Runs will still execute but history will not be recorded.",
      "  Fix: check write permissions on the rigg data directory.",
    ]
  }

  if (lower.includes("malformed") || lower.includes("not a database") || lower.includes("corrupt")) {
    return [
      `⚠ Run history database is corrupted: ${path}`,
      "  Runs will still execute but history will not be recorded.",
    ]
  }

  return [
    `⚠ Could not initialize run history database: ${msg}`,
    "  Runs will still execute but history will not be recorded.",
  ]
}

function migrateWarning(err: unknown, source: Source) {
  return [
    `⚠ Run history database needs migration but auto-migrate failed: ${normalizeError(err).message}`,
    source.kind === "bundled" ? "  Source: bundled migrations in the rigg binary." : `  Source: ${source.path}`,
    "  Runs will still execute but history will not be recorded.",
  ]
}

function resolveBundled() {
  if (typeof RIGG_BUNDLED_MIGRATIONS === "undefined" || RIGG_BUNDLED_MIGRATIONS.length === 0) {
    return
  }

  return RIGG_BUNDLED_MIGRATIONS
}

function hasFolder(path: string) {
  return existsSync(resolve(path, "meta", "_journal.json"))
}

function resolveSource(dir?: string): Source {
  if (dir) {
    if (!hasFolder(dir)) {
      return { kind: "missing", path: dir }
    }
    return { kind: "folder", path: dir }
  }

  const bundled = resolveBundled()
  if (bundled) {
    return { kind: "bundled", migrations: bundled }
  }

  const path = resolveFolder()
  if (!hasFolder(path)) {
    return { kind: "missing", path }
  }
  return { kind: "folder", path }
}

function runMigrations(db: Db, source: Source) {
  if (source.kind === "bundled") {
    migrateBundled(db, source.migrations)
    return
  }

  migrate(db, { migrationsFolder: source.path })
}

async function cleanup(path: string) {
  await Promise.allSettled(
    [
      path,
      `${path}-shm`,
      `${path}-wal`,
      `${path}.migrate.lock`,
      `${path}.migrate.lock-shm`,
      `${path}.migrate.lock-wal`,
    ].map((item) => rm(item, { force: true })),
  )
}

function withLock<T>(path: string, run: () => T): T {
  const db = openClient(`${path}.migrate.lock`)
  try {
    db.run("PRAGMA busy_timeout = 5000;")
    db.run("BEGIN IMMEDIATE")
    try {
      const out = run()
      db.run("COMMIT")
      return out
    } catch (err) {
      db.run("ROLLBACK")
      throw err
    }
  } finally {
    db.close(false)
  }
}

export async function openDb(opts: Opts = {}): Promise<OpenDbResult> {
  const path = resolveDbPath(opts.env)
  const existed = existsSync(path)
  const source = resolveSource(opts.migrationsFolder)
  let db: Db | undefined

  try {
    await mkdir(dirname(path), { recursive: true })
    const result = withLock(path, (): OpenResult => {
      try {
        db = createDb(path)
      } catch (err) {
        return { kind: "open_failed", err }
      }

      try {
        if (source.kind === "missing") {
          return { kind: "migrate_failed", err: new Error(`Can't find migrations at ${source.path}`) }
        }

        runMigrations(db, source)
        return { kind: "ok", db }
      } catch (err) {
        return { kind: "migrate_failed", err }
      }
    })

    if (result.kind === "ok") {
      return result
    }

    if (db) {
      closeDb(db)
    }
    if (!existed) {
      await cleanup(path)
    }
    if (result.kind === "migrate_failed") {
      return { kind: "disabled", warning: migrateWarning(result.err, source) }
    }
    return { kind: "disabled", warning: openWarning(result.err, path) }
  } catch (err) {
    if (db) {
      closeDb(db)
    }
    if (!existed) {
      await cleanup(path)
    }
    return { kind: "disabled", warning: openWarning(err, path) }
  }
}

export function closeDb(db: Db) {
  db.$client.close(false)
}

export function tx<T>(db: Conn, run: (db: Tx) => T): T {
  return db.transaction(run)
}
