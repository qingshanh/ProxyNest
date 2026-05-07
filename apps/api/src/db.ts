import fs from 'node:fs'
import path from 'node:path'
import initSqlJs, { type BindParams, type Database as SqlDatabase } from 'sql.js'

export class AppDb {
  private persistTimer: NodeJS.Timeout | null = null
  private dirty = false
  private readonly persistDebounceMs = Math.max(
    500,
    Number(process.env.DB_PERSIST_DEBOUNCE_MS ?? 5000) || 5000
  )

  private constructor(
    private readonly db: SqlDatabase,
    private readonly filePath: string
  ) {}

  static async open(filePath: string): Promise<AppDb> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'))
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(wasmDir, file)
    })
    const db = fs.existsSync(filePath)
      ? new SQL.Database(fs.readFileSync(filePath))
      : new SQL.Database()
    const appDb = new AppDb(db, filePath)
    appDb.migrate()
    appDb.persist()
    return appDb
  }

  exec(sql: string, persist = true): void {
    this.db.exec(sql)
    if (persist) this.schedulePersist()
  }

  run(sql: string, params: BindParams = [], persist = true): void {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params)
      while (stmt.step()) {
        // Exhaust possible result rows for statements that return metadata.
      }
    } finally {
      stmt.free()
    }
    if (persist) this.schedulePersist()
  }

  all<T extends Record<string, unknown>>(sql: string, params: BindParams = []): T[] {
    const stmt = this.db.prepare(sql)
    const rows: T[] = []
    try {
      stmt.bind(params)
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T)
      }
    } finally {
      stmt.free()
    }
    return rows
  }

  get<T extends Record<string, unknown>>(sql: string, params: BindParams = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  transaction<T>(fn: () => T): T {
    this.exec('BEGIN TRANSACTION', false)
    try {
      const result = fn()
      this.exec('COMMIT', false)
      this.schedulePersist()
      return result
    } catch (error) {
      this.exec('ROLLBACK', false)
      throw error
    }
  }

  persist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.dirty = false
    fs.writeFileSync(this.filePath, Buffer.from(this.db.export()))
  }

  close(): void {
    this.persist()
    this.db.close()
  }

  private schedulePersist(): void {
    this.dirty = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      if (this.dirty) this.persist()
    }, this.persistDebounceMs)
  }

  private migrate(): void {
    this.exec(
      `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscription_sources (
        id TEXT PRIMARY KEY,
        name TEXT,
        url TEXT NOT NULL UNIQUE,
        original_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        valid INTEGER NOT NULL DEFAULT 0,
        last_fetch_at TEXT,
        last_error TEXT,
        last_success_at TEXT,
        failed_fetch_count INTEGER NOT NULL DEFAULT 0,
        auto_delete_failed_fetches INTEGER,
        discovered_by TEXT,
        content_signature TEXT,
        node_count INTEGER NOT NULL DEFAULT 0,
        type_summary_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        protocol TEXT NOT NULL,
        original_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        raw_uri TEXT,
        clash_json TEXT,
        server TEXT NOT NULL,
        port INTEGER NOT NULL,
        country_code TEXT,
        country_name TEXT,
        exit_ip TEXT,
        alive INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        speed_bps INTEGER,
        speed_qualified INTEGER NOT NULL DEFAULT 0,
        unlock_json TEXT NOT NULL DEFAULT '{}',
        duplicate_group TEXT,
        last_tested_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_fingerprint ON nodes(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_nodes_alive ON nodes(alive);
      CREATE INDEX IF NOT EXISTS idx_nodes_protocol ON nodes(protocol);
      CREATE INDEX IF NOT EXISTS idx_nodes_country ON nodes(country_code);

      CREATE TABLE IF NOT EXISTS node_pool (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        node_json TEXT NOT NULL,
        quality_score INTEGER NOT NULL DEFAULT 0,
        success_streak INTEGER NOT NULL DEFAULT 0,
        fail_streak INTEGER NOT NULL DEFAULT 0,
        alive_fail_streak INTEGER NOT NULL DEFAULT 0,
        speed_fail_streak INTEGER NOT NULL DEFAULT 0,
        latency_fail_streak INTEGER NOT NULL DEFAULT 0,
        keep_for_reprobe INTEGER NOT NULL DEFAULT 1,
        pool_reason TEXT,
        last_pool_at TEXT,
        next_recheck_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_node_pool_quality ON node_pool(quality_score DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_node_pool_reprobe ON node_pool(keep_for_reprobe, next_recheck_at);

      CREATE TABLE IF NOT EXISTS test_runs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        params_json TEXT NOT NULL DEFAULT '{}',
        progress_json TEXT,
        stats_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        format TEXT NOT NULL,
        file_path TEXT NOT NULL,
        public_path TEXT NOT NULL,
        node_count INTEGER NOT NULL DEFAULT 0,
        token TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      `,
      false
    )
    this.ensureColumn('subscription_sources', 'original_url', 'TEXT')
    this.ensureColumn('subscription_sources', 'last_success_at', 'TEXT')
    this.ensureColumn('subscription_sources', 'failed_fetch_count', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('subscription_sources', 'auto_delete_failed_fetches', 'INTEGER')
    this.ensureColumn('subscription_sources', 'discovered_by', 'TEXT')
    this.ensureColumn('subscription_sources', 'content_signature', 'TEXT')
    this.ensureColumn('node_pool', 'alive_fail_streak', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('node_pool', 'speed_fail_streak', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('node_pool', 'latency_fail_streak', 'INTEGER NOT NULL DEFAULT 0')
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.all<{ name: string }>(`PRAGMA table_info(${table})`)
    if (rows.some((row) => row.name === column)) return
    this.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, [], false)
  }
}
