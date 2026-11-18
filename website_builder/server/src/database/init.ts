import { DatabaseSync, type StatementSync } from 'node:sqlite'
import path from 'path'
import fs from 'fs'

const DATA_DIR = (process.env.LUMEN_STUDIO_DATA_DIR || path.join(process.cwd(), 'data'))
const DB_PATH = path.join(DATA_DIR, 'lumen.db')

let db: DatabaseSync | null = null

/**
 * Thin shim over node:sqlite's DatabaseSync so the rest of the codebase keeps
 * using the same .prepare(...).run/get/all surface that better-sqlite3 had.
 */
export interface AppDatabase {
  prepare(sql: string): StatementSync
  exec(sql: string): void
  pragma(sql: string): void
  transaction<TArgs extends unknown[], TReturn>(fn: (...args: TArgs) => TReturn): (...args: TArgs) => TReturn
  close(): void
}

function wrap(raw: DatabaseSync): AppDatabase {
  return {
    prepare: (sql: string) => raw.prepare(sql),
    exec: (sql: string) => raw.exec(sql),
    pragma: (sql: string) => raw.exec(`PRAGMA ${sql}`),
    transaction: <TArgs extends unknown[], TReturn>(fn: (...args: TArgs) => TReturn) => {
      return (...args: TArgs): TReturn => {
        raw.exec('BEGIN')
        try {
          const result = fn(...args)
          raw.exec('COMMIT')
          return result
        } catch (err) {
          try { raw.exec('ROLLBACK') } catch { /* ignore */ }
          throw err
        }
      }
    },
    close: () => raw.close()
  }
}

export function getDb(): AppDatabase {
  if (!db) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
    }
    db = new DatabaseSync(DB_PATH)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
  }
  return wrap(db)
}

/**
 * Initialise the database schema.
 *
 * Two tables only:
 *   - audits      stores completed website audits keyed by uuid
 *   - blueprints  stores generated AI builder prompts keyed by uuid
 */
export function initDatabase(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }

  const database = getDb()

  database.exec(`
    CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      performance_score INTEGER DEFAULT 0,
      seo_score INTEGER DEFAULT 0,
      marketing_score INTEGER DEFAULT 0,
      conversion_score INTEGER DEFAULT 0,
      security_score INTEGER DEFAULT 0,
      overall_score INTEGER DEFAULT 0,
      opportunity_score INTEGER DEFAULT 0,
      opportunity_level TEXT DEFAULT 'low',
      raw_data TEXT,
      status TEXT DEFAULT 'completed'
    );

    CREATE TABLE IF NOT EXISTS blueprints (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      business_name TEXT NOT NULL,
      niche TEXT NOT NULL,
      raw_data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audits_created_at ON audits(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_blueprints_created_at ON blueprints(created_at DESC);
  `)

  console.log('Database initialized')
}
