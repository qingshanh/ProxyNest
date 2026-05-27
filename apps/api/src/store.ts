import bcrypt from 'bcryptjs'
import fs from 'node:fs'
import type { AppConfig } from './config'
import type { AppDb } from './db'
import type {
  AppSettings,
  ArtifactEntity,
  DedupeMode,
  NodeEntity,
  NormalizedNode,
  ProbeCandidate,
  ReusableNodeEntity,
  PageResult,
  RunProgress,
  RunStatus,
  RunType,
  SourceEntity,
  TestRunEntity,
  SecurityCheck,
  UnlockMap
} from './types'
import {
  fromIntBool,
  newId,
  nowIso,
  randomToken,
  safeJsonParse,
  sha256,
  toIntBool,
  toMBps
} from './utils'

type Row = Record<string, unknown>
type PoolRow = Record<string, unknown>

type NodeFilters = {
  alive?: boolean
  protocol?: string
  country?: string
  unlock?: string
  minSpeedMBps?: number
  scope?: 'all' | 'current' | 'pool'
  page: number
  pageSize: number
  sort?: string
  order?: 'asc' | 'desc'
}

type PoolFilters = {
  page: number
  pageSize: number
  keepForReprobe?: boolean
  country?: string
  sort?: string
  order?: 'asc' | 'desc'
}

type ProbeCandidateFilters = {
  aliveOnly?: boolean
  includeAllPool?: boolean
}

type ReuseDecision = {
  keepForReprobe: boolean
  qualityScore: number
  successStreak: number
  failStreak: number
  aliveFailStreak: number
  speedFailStreak: number
  latencyFailStreak: number
  nextRecheckAt: string | null
  poolReason: string | null
  removeFromPool?: boolean
}

const securityRiskOf = (node: Partial<NodeEntity> | null | undefined): string => node?.security?.risk ?? 'unknown'

const deepMerge = <T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T => {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      out[key] = deepMerge(base[key] as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out as T
}

export class Store {
  constructor(
    private readonly db: AppDb,
    private readonly config: AppConfig
  ) {}

  async bootstrap(): Promise<void> {
    await this.ensureAdminUser()
    this.ensureSettings()
    this.deleteExpiredSessions()
    this.pruneDeadCurrentNodes()
    this.pruneDeadReusableNodes()
    this.pruneRunsByAge(this.getSettings().schedule.runHistoryRetentionDays)
  }

  async ensureAdminUser(): Promise<void> {
    const existing = this.db.get<Row>('SELECT id, password_hash FROM users LIMIT 1')
    if (existing) {
      await this.upgradeDefaultAdminPassword(existing)
      return
    }
    const id = 'u_1'
    const now = nowIso()
    const hash = await bcrypt.hash(this.config.adminPassword, 10)
    this.db.run(
      'INSERT INTO users (id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [id, hash, now, now]
    )
  }

  private async upgradeDefaultAdminPassword(user: Row): Promise<void> {
    if (!this.config.adminPassword || this.config.adminPassword === 'admin') return
    const stillDefault = await bcrypt.compare('admin', String(user.password_hash))
    if (!stillDefault) return
    const userId = String(user.id)
    const hash = await bcrypt.hash(this.config.adminPassword, 10)
    this.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      hash,
      nowIso(),
      userId
    ])
    this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId])
  }

  async verifyPassword(password: string): Promise<string | null> {
    const user = this.db.get<Row>('SELECT id, password_hash FROM users LIMIT 1')
    if (!user) return null
    const ok = await bcrypt.compare(password, String(user.password_hash))
    return ok ? String(user.id) : null
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
    const userId = await this.verifyPassword(oldPassword)
    if (!userId) return false
    const hash = await bcrypt.hash(newPassword, 10)
    this.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      hash,
      nowIso(),
      userId
    ])
    this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId])
    return true
  }

  createSession(userId: string): string {
    const token = randomToken()
    const now = new Date()
    const settings = this.getSettings()
    const expires = new Date(now.getTime() + settings.auth.sessionTtlDays * 24 * 60 * 60 * 1000)
    this.db.run(
      'INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      [newId('sess'), sha256(token), userId, expires.toISOString(), now.toISOString()]
    )
    return token
  }

  getSessionUser(token: string): { id: string } | null {
    this.deleteExpiredSessions()
    const row = this.db.get<Row>(
      'SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1',
      [sha256(token), nowIso()]
    )
    if (!row) return null
    return { id: String(row.user_id) }
  }

  deleteSession(token: string): void {
    this.db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)])
  }

  deleteExpiredSessions(): void {
    this.db.run('DELETE FROM sessions WHERE expires_at <= ?', [nowIso()])
  }

  ensureSettings(): void {
    const settings = this.db.get<Row>("SELECT key FROM settings WHERE key = 'app'")
    if (settings) {
      this.migrateSettingsDefaults()
      return
    }
    this.saveSettings(this.defaultSettings())
  }

  private migrateSettingsDefaults(): void {
    const settings = this.getSettings()
    let changed = false
    if (settings.dedupe.defaultMode === 'normalized_config') {
      settings.dedupe.defaultMode = 'endpoint'
      changed = true
    }
    if (!this.config.publicBaseUrl && settings.publicBaseUrl === 'http://localhost:8080') {
      settings.publicBaseUrl = ''
      changed = true
    }
    if (settings.concurrency.aliveRecommended === 100) {
      settings.concurrency.aliveRecommended = 300
      changed = true
    }
    if ([8, 12].includes(settings.concurrency.speedRecommended)) {
      settings.concurrency.speedRecommended = 4
      changed = true
    }
    if (!('databaseUrl' in (settings.geoip as unknown as Record<string, unknown>))) {
      settings.geoip = { ...this.defaultSettings().geoip, ...(settings.geoip as unknown as Record<string, unknown>) }
      changed = true
    }
    if (!settings.unlockTest || typeof settings.unlockTest !== 'object') {
      settings.unlockTest = this.defaultSettings().unlockTest
      changed = true
    }
    if (!('absoluteMinSpeedMBps' in (settings.reusablePool as unknown as Record<string, unknown>))) {
      settings.reusablePool.absoluteMinSpeedMBps = 1
      changed = true
    }
    if (changed) this.saveSettings(settings)
  }

  defaultSettings(): AppSettings {
    return {
      auth: {
        sessionTtlDays: this.config.sessionTtlDays
      },
      dedupe: {
        defaultMode: 'endpoint'
      },
      subscriptions: {
        autoDeleteFailedFetches: 3
      },
      unlockTest: {
        openai: 'https://chatgpt.com/',
        youtube: 'https://www.youtube.com/premium',
        netflix: 'https://www.netflix.com/title/80018499',
        disney: 'https://www.disneyplus.com/'
      },
      geoip: {
        mode: 'local_with_api_fallback',
        apiUrl: '',
        databaseUrl: 'https://downloads.ip66.dev/db/ip66.mmdb',
        autoUpdate: false,
        updateCron: '0 3 * * *',
        lastUpdatedAt: null,
        lastUpdateError: null
      },
      github: {
        rawProxyPrefix: this.config.githubRawProxyPrefix,
        apiBaseUrl: this.config.githubApiBaseUrl || 'https://api.github.com',
        token: this.config.githubToken,
        tokenSet: Boolean(this.config.githubToken),
        discovery: {
          enabled: false,
          searchDays: 7,
          maxRepos: 40,
          maxCandidates: 120,
          maxAdditions: 30,
          concurrency: 12,
          validateCandidates: true,
          queries: [
            'clash subscription',
            'clash meta subscription',
            'v2ray subscription',
            'vless trojan subscription',
            'mihomo subscription',
            'proxy provider yaml',
            'free clash subscription',
            'free v2ray subscription',
            'clash nodes',
            'v2ray nodes',
            '免费 节点 订阅',
            'clash 订阅',
            'v2ray 订阅'
          ]
        }
      },
      concurrency: {
        aliveRecommended: 300,
        speedRecommended: 4,
        unlockRecommended: 40
      },
      reusablePool: {
        absoluteMinSpeedMBps: 1,
        minSpeedMBps: 3,
        maxLatencyMs: 800,
        removeAfterAliveFailures: 3,
        removeAfterSpeedFailures: 3,
        removeAfterLatencyFailures: 3
      },
      telegram: {
        enabled: this.config.telegramEnabled,
        botToken: this.config.telegramBotToken,
        botTokenSet: Boolean(this.config.telegramBotToken),
        chatId: this.config.telegramChatId,
        apiBaseUrl: this.config.telegramApiBaseUrl
      },
      schedule: {
        enabled: false,
        cron: '0 4 * * *',
        runHistoryRetentionDays: 30,
        tasks: [
          {
            id: 'full',
            type: 'full',
            enabled: false,
            cron: '0 4 * * *',
            notifyTelegram: true
          },
          {
            id: 'pool_alive',
            type: 'pool_alive',
            enabled: false,
            cron: '30 */6 * * *',
            notifyTelegram: false
          },
          {
            id: 'speed',
            type: 'speed',
            enabled: false,
            cron: '0 */8 * * *',
            notifyTelegram: false
          },
          {
            id: 'unlock',
            type: 'unlock',
            enabled: false,
            cron: '20 */8 * * *',
            notifyTelegram: false
          }
        ]
      },
      publicBaseUrl: this.config.publicBaseUrl,
      subToken: randomToken()
    }
  }

  getSettings(): AppSettings {
    const row = this.db.get<Row>("SELECT value_json FROM settings WHERE key = 'app'")
    if (!row) return this.defaultSettings()
    const parsed = safeJsonParse<AppSettings>(String(row.value_json), this.defaultSettings())
    const merged = deepMerge(
      this.defaultSettings() as unknown as Record<string, unknown>,
      parsed as unknown as Record<string, unknown>
    ) as unknown as AppSettings
    return this.normalizeSettings(merged)
  }

  private normalizeSettings(settings: AppSettings): AppSettings {
    const defaults = this.defaultSettings()
    if (!settings.github || typeof settings.github !== 'object') {
      settings.github = defaults.github
    }
    if (
      !settings.github.discovery ||
      typeof settings.github.discovery !== 'object' ||
      Array.isArray(settings.github.discovery)
    ) {
      settings.github.discovery = defaults.github.discovery
    }
    if (!settings.schedule || typeof settings.schedule !== 'object') {
      settings.schedule = defaults.schedule
    }
    if (!Array.isArray(settings.schedule.tasks)) {
      settings.schedule.tasks = defaults.schedule.tasks
    }
    if (!Number.isFinite(Number(settings.schedule.runHistoryRetentionDays))) {
      settings.schedule.runHistoryRetentionDays = defaults.schedule.runHistoryRetentionDays
    }
    if (!settings.reusablePool || typeof settings.reusablePool !== 'object') {
      settings.reusablePool = defaults.reusablePool
    }
    if (!settings.unlockTest || typeof settings.unlockTest !== 'object') {
      settings.unlockTest = defaults.unlockTest
    }
    settings.unlockTest = { ...defaults.unlockTest, ...settings.unlockTest }
    settings.geoip = { ...defaults.geoip, ...settings.geoip }
    settings.reusablePool = { ...defaults.reusablePool, ...settings.reusablePool }
    return settings
  }

  getPublicSettings(): Omit<AppSettings, 'subToken'> & {
    subTokenSet: boolean
    mihomo: { bin: string; configured: boolean; exists: boolean }
  } {
    const settings = this.getSettings()
    const { subToken: _subToken, telegram, github, ...rest } = settings
    return {
      ...rest,
      telegram: {
        ...telegram,
        botToken: undefined,
        botTokenSet: Boolean(telegram.botToken)
      },
      github: {
        ...github,
        token: undefined,
        tokenSet: Boolean(github.token)
      },
      mihomo: {
        bin: this.config.mihomoBin,
        configured: Boolean(this.config.mihomoBin),
        exists: Boolean(this.config.mihomoBin && fs.existsSync(this.config.mihomoBin))
      },
      subTokenSet: Boolean(_subToken)
    }
  }

  patchSettings(patch: Record<string, unknown>): AppSettings {
    const current = this.getSettings()
    const next = deepMerge(current as unknown as Record<string, unknown>, patch) as unknown as AppSettings
    if (patch.telegram && typeof patch.telegram === 'object') {
      const telegramPatch = patch.telegram as Record<string, unknown>
      if (!('botToken' in telegramPatch) || telegramPatch.botToken == null || telegramPatch.botToken === '') {
        next.telegram.botToken = current.telegram.botToken
      }
      next.telegram.botTokenSet = Boolean(next.telegram.botToken)
    }
    if (patch.github && typeof patch.github === 'object') {
      const githubPatch = patch.github as Record<string, unknown>
      if (!('token' in githubPatch) || githubPatch.token == null || githubPatch.token === '') {
        next.github.token = current.github.token
      }
      next.github.apiBaseUrl = this.cleanUrl(next.github.apiBaseUrl, 'https://api.github.com')
      next.github.rawProxyPrefix = this.cleanUrl(next.github.rawProxyPrefix, '')
      next.github.discovery.searchDays = this.clampInt(next.github.discovery.searchDays, 1, 365, current.github.discovery.searchDays)
      next.github.discovery.maxRepos = this.clampInt(next.github.discovery.maxRepos, 1, 500, current.github.discovery.maxRepos)
      next.github.discovery.maxCandidates = this.clampInt(next.github.discovery.maxCandidates, 1, 1000, current.github.discovery.maxCandidates)
      next.github.discovery.maxAdditions = this.clampInt(next.github.discovery.maxAdditions, 1, 500, current.github.discovery.maxAdditions)
      next.github.discovery.concurrency = this.clampInt(next.github.discovery.concurrency, 1, 20, current.github.discovery.concurrency)
      next.github.tokenSet = Boolean(next.github.token)
    }
    if (patch.unlockTest && typeof patch.unlockTest === 'object') {
      next.unlockTest = {
        openai: this.cleanUrl(next.unlockTest.openai, current.unlockTest.openai),
        youtube: this.cleanUrl(next.unlockTest.youtube, current.unlockTest.youtube),
        netflix: this.cleanUrl(next.unlockTest.netflix, current.unlockTest.netflix),
        disney: this.cleanUrl(next.unlockTest.disney, current.unlockTest.disney)
      }
    }
    this.saveSettings(next)
    return next
  }

  private cleanUrl(value: unknown, fallback: string): string {
    const trimmed = String(value ?? '').trim()
    if (!trimmed) return fallback
    return trimmed.replace(/\/+$/, '')
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.floor(parsed)))
  }
  regenerateSubToken(): string {
    const settings = this.getSettings()
    settings.subToken = randomToken()
    this.saveSettings(settings)
    return settings.subToken
  }

  saveSettings(settings: AppSettings): void {
    this.db.run(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES ('app', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [JSON.stringify(settings), nowIso()]
    )
  }

  clearCurrentNodes(): void {
    this.db.run('DELETE FROM nodes')
  }

  clearCurrentNodesForSource(sourceId: string): void {
    this.db.transaction(() => {
      const rows = this.db.all<Row>('SELECT id, source_ids_json FROM nodes')
      for (const row of rows) {
        const sourceIds = safeJsonParse<string[]>(String(row.source_ids_json), []).filter((item) => item !== sourceId)
        if (sourceIds.length === 0) {
          this.db.run('DELETE FROM nodes WHERE id = ?', [String(row.id)], false)
        } else {
          this.db.run(
            'UPDATE nodes SET source_ids_json = ?, updated_at = ? WHERE id = ?',
            [JSON.stringify(sourceIds), nowIso(), String(row.id)],
            false
          )
        }
      }
    })
  }

  listSources(): SourceEntity[] {
    return this.db
      .all<Row>('SELECT * FROM subscription_sources ORDER BY created_at DESC')
      .map((row) => this.mapSource(row))
  }

  getSource(id: string): SourceEntity | null {
    const row = this.db.get<Row>('SELECT * FROM subscription_sources WHERE id = ?', [id])
    return row ? this.mapSource(row) : null
  }

  getSourceByUrl(url: string): SourceEntity | null {
    const row = this.db.get<Row>('SELECT * FROM subscription_sources WHERE url = ?', [url])
    return row ? this.mapSource(row) : null
  }

  canonicalizeSourceUrl(id: string, url: string, originalUrl: string | null): SourceEntity | null {
    const source = this.getSource(id)
    if (!source) return null
    if (source.url === url && source.originalUrl === originalUrl) return source
    const existing = this.getSourceByUrl(url)
    if (existing && existing.id !== id) {
      this.deleteSource(id)
      return existing
    }
    this.db.run(
      'UPDATE subscription_sources SET url = ?, original_url = ?, updated_at = ? WHERE id = ?',
      [url, originalUrl, nowIso(), id]
    )
    return this.getSource(id)
  }

  upsertSource(input: {
    id?: string
    name?: string | null
    url: string
    originalUrl?: string | null
    valid: boolean
    nodeCount: number
    typeSummary: Record<string, number>
    lastError?: string | null
    autoDeleteFailedFetches?: number | null
    discoveredBy?: string | null
    contentSignature?: string | null
  }): SourceEntity {
    const now = nowIso()
    const existing = this.getSourceByUrl(input.url)
    const id = existing?.id ?? input.id ?? newId('sub')
    const failedFetchCount = input.valid ? 0 : (existing?.failedFetchCount ?? 0) + 1
    const lastSuccessAt = input.valid ? now : (existing?.lastSuccessAt ?? null)
    if (existing) {
      this.db.run(
        `UPDATE subscription_sources
         SET name = COALESCE(?, name),
             original_url = COALESCE(?, original_url),
             valid = ?,
             last_fetch_at = ?,
             last_error = ?,
             last_success_at = ?,
             failed_fetch_count = ?,
             auto_delete_failed_fetches = ?,
             discovered_by = COALESCE(?, discovered_by),
             content_signature = ?,
             node_count = ?,
             type_summary_json = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          input.name ?? existing.name,
          input.originalUrl ?? existing.originalUrl,
          toIntBool(input.valid),
          now,
          input.lastError ?? null,
          lastSuccessAt,
          failedFetchCount,
          input.autoDeleteFailedFetches === undefined
            ? existing.autoDeleteFailedFetches
            : input.autoDeleteFailedFetches,
          input.discoveredBy ?? existing.discoveredBy,
          input.contentSignature === undefined ? existing.contentSignature : input.contentSignature,
          input.nodeCount,
          JSON.stringify(input.typeSummary),
          now,
          id
        ]
      )
    } else {
      this.db.run(
        `INSERT INTO subscription_sources
         (id, name, url, original_url, enabled, valid, last_fetch_at, last_error, last_success_at,
          failed_fetch_count, auto_delete_failed_fetches, discovered_by, content_signature, node_count, type_summary_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name ?? null,
          input.url,
          input.originalUrl ?? null,
          toIntBool(input.valid),
          now,
          input.lastError ?? null,
          lastSuccessAt,
          failedFetchCount,
          input.autoDeleteFailedFetches ?? null,
          input.discoveredBy ?? null,
          input.contentSignature ?? null,
          input.nodeCount,
          JSON.stringify(input.typeSummary),
          now,
          now
        ]
      )
    }
    return this.getSource(id)!
  }

  updateSource(
    id: string,
    patch: { name?: string; enabled?: boolean; autoDeleteFailedFetches?: number | null }
  ): SourceEntity | null {
    const source = this.getSource(id)
    if (!source) return null
    this.db.run(
      `UPDATE subscription_sources
       SET name = ?,
           enabled = ?,
           auto_delete_failed_fetches = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        patch.name ?? source.name,
        toIntBool(patch.enabled ?? source.enabled),
        patch.autoDeleteFailedFetches === undefined
          ? source.autoDeleteFailedFetches
          : patch.autoDeleteFailedFetches,
        nowIso(),
        id
      ]
    )
    return this.getSource(id)
  }

  deleteSource(id: string): boolean {
    const source = this.getSource(id)
    if (!source) return false
    this.db.run('DELETE FROM subscription_sources WHERE id = ?', [id])
    this.clearCurrentNodesForSource(id)
    return true
  }

  deleteSourceIfExceededFailures(id: string): boolean {
    const source = this.getSource(id)
    if (!source) return false
    const threshold = source.autoDeleteFailedFetches ?? this.getSettings().subscriptions.autoDeleteFailedFetches
    if (threshold <= 0 || source.failedFetchCount < threshold) return false
    return this.deleteSource(id)
  }

  upsertNodes(sourceId: string, nodes: NormalizedNode[]): { rawNodes: number; uniqueNodes: number } {
    const now = nowIso()
    const inputCount = nodes.length
    const dedupedNodes = this.dedupeNormalizedNodes(nodes, this.getSettings().dedupe.defaultMode)
    const existingByFingerprint = new Map(
      this.db.all<Row>('SELECT * FROM nodes').map((row) => [String(row.fingerprint), row])
    )
    this.db.transaction(() => {
      for (const node of dedupedNodes) {
        const existing = existingByFingerprint.get(node.fingerprint)
        if (existing) {
          const sourceIds = safeJsonParse<string[]>(String(existing.source_ids_json), [])
          if (!sourceIds.includes(sourceId)) sourceIds.push(sourceId)
          this.db.run(
            `UPDATE nodes
             SET source_ids_json = ?,
                 raw_uri = COALESCE(raw_uri, ?),
                 clash_json = COALESCE(clash_json, ?),
                 updated_at = ?
             WHERE id = ?`,
            [
              JSON.stringify(sourceIds),
              node.rawUri ?? null,
              node.clash ? JSON.stringify(node.clash) : null,
              now,
              String(existing.id)
            ],
            false
          )
          existing.source_ids_json = JSON.stringify(sourceIds)
          existing.raw_uri = existing.raw_uri ?? node.rawUri ?? null
          existing.clash_json = existing.clash_json ?? (node.clash ? JSON.stringify(node.clash) : null)
          existing.updated_at = now
        } else {
          this.db.run(
            `INSERT INTO nodes
             (id, fingerprint, source_ids_json, protocol, original_name, display_name, raw_uri, clash_json,
              server, port, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              node.id,
              node.fingerprint,
              JSON.stringify([sourceId]),
              node.protocol,
              node.originalName,
              node.displayName,
              node.rawUri ?? null,
              node.clash ? JSON.stringify(node.clash) : null,
              node.server,
              node.port,
              now,
              now
            ],
            false
          )
          existingByFingerprint.set(node.fingerprint, {
            id: node.id,
            fingerprint: node.fingerprint,
            source_ids_json: JSON.stringify([sourceId]),
            raw_uri: node.rawUri ?? null,
            clash_json: node.clash ? JSON.stringify(node.clash) : null,
            updated_at: now
          })
        }
      }
    })
    return {
      rawNodes: inputCount,
      uniqueNodes: Number(this.db.get<Row>('SELECT COUNT(*) AS c FROM nodes')?.c ?? 0)
    }
  }

  listNodes(filters: NodeFilters): PageResult<NodeEntity> {
    const where: string[] = []
    const params: Array<string | number | null> = []
    if (filters.alive != null) {
      where.push('alive = ?')
      params.push(toIntBool(filters.alive))
    }
    if (filters.protocol) {
      where.push('protocol = ?')
      params.push(filters.protocol)
    }
    if (filters.country) {
      where.push('country_code = ?')
      params.push(filters.country.toUpperCase())
    }
    if (filters.minSpeedMBps != null) {
      where.push('speed_bps >= ?')
      params.push(Math.round(filters.minSpeedMBps * 1024 * 1024))
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const sortCols: Record<string, string> = {
      alive: 'alive', speed_bps: 'speed_bps', latency_ms: 'latency_ms',
      country_code: 'country_code', protocol: 'protocol', display_name: 'display_name',
      created_at: 'created_at'
    }
    const sort = filters.sort && sortCols[filters.sort] ? sortCols[filters.sort] : null
    const orderDir = filters.order === 'asc' ? 'ASC' : 'DESC'
    const orderSql = sort
      ? `ORDER BY ${sort} ${orderDir}, created_at DESC`
      : `ORDER BY alive DESC, speed_bps DESC, latency_ms ASC, created_at DESC`
    if (!filters.unlock) {
      const total = Number(this.db.get<Row>(`SELECT COUNT(*) AS c FROM nodes ${whereSql}`, params)?.c ?? 0)
      const rows = this.db.all<Row>(
        `SELECT * FROM nodes ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
        [...params, filters.pageSize, (filters.page - 1) * filters.pageSize]
      )
      return {
        items: rows.map((row) => this.mapNode(row)),
        page: filters.page,
        pageSize: filters.pageSize,
        total
      }
    }
    const rawRows = this.db.all<Row>(
      `SELECT * FROM nodes ${whereSql} ${orderSql}`,
      params
    )
    let items = rawRows.map((row) => this.mapNode(row))
    if (filters.unlock) {
      items = items.filter((item) => item.unlock[filters.unlock as keyof UnlockMap]?.available)
    }
    const total = items.length
    const start = (filters.page - 1) * filters.pageSize
    items = items.slice(start, start + filters.pageSize)
    return {
      items,
      page: filters.page,
      pageSize: filters.pageSize,
      total
    }
  }

  getNode(id: string): NodeEntity | null {
    const row = this.db.get<Row>('SELECT * FROM nodes WHERE id = ?', [id])
    return row ? this.mapNode(row) : null
  }

  getAllNodes(): NodeEntity[] {
    return this.db.all<Row>('SELECT * FROM nodes').map((row) => this.mapNode(row))
  }

  exportNodes(filters: Omit<NodeFilters, 'page' | 'pageSize'>): NodeEntity[] {
    return this.listNodes({ ...filters, page: 1, pageSize: 99999 }).items
  }

  exportReusableNodes(filters: Omit<PoolFilters, 'page' | 'pageSize'>): ReusableNodeEntity[] {
    return this.listReusableNodes({ ...filters, page: 1, pageSize: 99999 }).items
  }

  getAliveNodes(): NodeEntity[] {
    return this.db
      .all<Row>('SELECT * FROM nodes WHERE alive = 1 ORDER BY latency_ms ASC, created_at DESC')
      .map((row) => this.mapNode(row))
  }

  listReusableNodes(filters: PoolFilters): PageResult<ReusableNodeEntity> {
    const rows = this.db.all<PoolRow>('SELECT * FROM node_pool')
    let items = rows.map((row) => this.mapReusableNode(row)).filter((item) => item.alive)
    if (filters.keepForReprobe != null) {
      items = items.filter((item) => item.keepForReprobe === filters.keepForReprobe)
    }
    if (filters.country) {
      items = items.filter((item) => item.countryCode === filters.country!.toUpperCase())
    }
    items = this.sortReusableNodes(items, filters.sort, filters.order)
    const total = items.length
    const start = (filters.page - 1) * filters.pageSize
    items = items.slice(start, start + filters.pageSize)
    return {
      items,
      page: filters.page,
      pageSize: filters.pageSize,
      total
    }
  }

  getReusableNodes(): ReusableNodeEntity[] {
    return this.db
      .all<PoolRow>('SELECT * FROM node_pool WHERE keep_for_reprobe = 1 ORDER BY quality_score DESC, updated_at DESC')
      .map((row) => this.mapReusableNode(row))
      .filter((item) => item.alive)
      .filter((item) => securityRiskOf(item) !== 'suspicious')
  }

  getReusableNode(id: string): ReusableNodeEntity | null {
    const row = this.db.get<PoolRow>('SELECT * FROM node_pool WHERE id = ?', [id])
    return row ? this.mapReusableNode(row) : null
  }

  getReusableNodeByFingerprint(fingerprint: string): ReusableNodeEntity | null {
    const row = this.db.get<PoolRow>('SELECT * FROM node_pool WHERE fingerprint = ?', [fingerprint])
    return row ? this.mapReusableNode(row) : null
  }

  deleteNode(id: string): boolean {
    const node = this.getNode(id)
    if (!node) return false
    this.db.run('DELETE FROM nodes WHERE id = ?', [id])
    const reusable = this.getReusableNodeByFingerprint(node.fingerprint)
    if (reusable) {
      this.deleteReusableNode(reusable.poolId)
    }
    return true
  }

  deleteDeadNode(id: string): boolean {
    const node = this.getNode(id)
    if (!node) return false
    if (node.alive) return false
    return this.deleteNode(id)
  }

  updateNodeProbe(
    id: string,
    patch: Partial<{
      displayName: string
      alive: boolean
      latencyMs: number | null
      speedBps: number | null
      speedQualified: boolean
      security: SecurityCheck
      countryCode: string | null
      countryName: string | null
      exitIp: string | null
      unlock: UnlockMap
      lastTestedAt: string
    }>
  ): NodeEntity | null {
    const node = this.getNode(id)
    if (!node) return null
    this.db.run(
      `UPDATE nodes
       SET display_name = ?,
           alive = ?,
           latency_ms = ?,
           speed_bps = ?,
           speed_qualified = ?,
           security_json = ?,
           country_code = ?,
           country_name = ?,
           exit_ip = ?,
           unlock_json = ?,
           last_tested_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        patch.displayName ?? node.displayName,
        toIntBool(patch.alive ?? node.alive),
        patch.latencyMs === undefined ? node.latencyMs : patch.latencyMs,
        patch.speedBps === undefined ? node.speedBps : patch.speedBps,
        toIntBool(patch.speedQualified ?? node.speedQualified),
        JSON.stringify(patch.security ?? node.security),
        patch.countryCode === undefined ? node.countryCode : patch.countryCode,
        patch.countryName === undefined ? node.countryName : patch.countryName,
        patch.exitIp === undefined ? node.exitIp : patch.exitIp,
        JSON.stringify(patch.unlock ?? node.unlock),
        patch.lastTestedAt ?? node.lastTestedAt,
        nowIso(),
        id
      ]
    )
    const updated = this.getNode(id)
    if (updated && this.affectsReusableQuality(patch)) this.considerReusableNode(updated, patch)
    return updated
  }

  updateReusableNodeProbe(
    id: string,
    patch: Partial<{
      node: Partial<NodeEntity>
      keepForReprobe: boolean
      qualityScore: number
      successStreak: number
      failStreak: number
      poolReason: string | null
      nextRecheckAt: string | null
    }>
  ): ReusableNodeEntity | null {
    const row = this.db.get<PoolRow>('SELECT * FROM node_pool WHERE id = ?', [id])
    if (!row) return null
    const current = this.mapReusableNode(row)
    const currentNode = this.extractReusableNode(current)
    const nextNode = patch.node ? this.mergeNode(currentNode, patch.node) : currentNode
    if (nextNode.alive === false) {
      this.deleteReusableNode(id)
      return null
    }
    const override = {
      keepForReprobe: patch.keepForReprobe,
      qualityScore: patch.qualityScore,
      successStreak:
        patch.successStreak ?? (patch.node && !('alive' in patch.node) ? current.successStreak : undefined),
      failStreak: patch.failStreak ?? (patch.node && !('alive' in patch.node) ? current.failStreak : undefined),
      aliveFailStreak: patch.node && !('alive' in patch.node) ? current.aliveFailStreak : undefined,
      speedFailStreak:
        patch.node && !('speedBps' in patch.node) && !('speedQualified' in patch.node)
          ? current.speedFailStreak
          : undefined,
      latencyFailStreak:
        patch.node && !('latencyMs' in patch.node) ? current.latencyFailStreak : undefined,
      poolReason: patch.poolReason,
      nextRecheckAt: patch.nextRecheckAt
    }
    const hasOverride = Object.values(override).some((value) => value !== undefined)
    const preserveDecision = !hasOverride && !this.affectsReusableQuality(patch.node ?? {})
    const decision = preserveDecision
      ? {
          keepForReprobe: current.keepForReprobe,
          qualityScore: current.qualityScore,
          successStreak: current.successStreak,
          failStreak: current.failStreak,
          aliveFailStreak: current.aliveFailStreak,
          speedFailStreak: current.speedFailStreak,
          latencyFailStreak: current.latencyFailStreak,
          poolReason: current.poolReason,
          nextRecheckAt: current.nextRecheckAt
        }
      : this.buildReuseDecision(nextNode, override, current)
    this.upsertReusableNode(nextNode, decision)
    return this.getReusableNode(id)
  }

  getProbeCandidates(filters: ProbeCandidateFilters = {}): ProbeCandidate[] {
    const now = nowIso()
    const current = this.getAllNodes().map((node) => ({
      origin: 'current' as const,
      node
    }))
    const pool = this.db
      .all<PoolRow>('SELECT * FROM node_pool ORDER BY quality_score DESC, updated_at DESC')
      .filter((row) => {
        if (!fromIntBool(row.keep_for_reprobe)) return false
        if (filters.includeAllPool) return true
        return row.next_recheck_at == null || String(row.next_recheck_at) <= now
      })
      .map((row) => {
        const reusable = this.mapReusableNode(row)
        return {
          origin: 'pool' as const,
          node: reusable,
          poolId: reusable.poolId
        }
      })
    const merged = this.mergeProbeCandidates([...current, ...pool])
    return filters.aliveOnly ? merged.filter((candidate) => candidate.node.alive) : merged
  }

  getExportNodes(): NodeEntity[] {
    return this.mergeNodesByFingerprint([
      ...this.getAllNodes(),
      ...this.getReusableNodes().map((entry) => this.extractReusableNode(entry))
    ])
  }

  getReusableCount(): number {
    return this.getReusableNodes().length
  }

  deleteReusableNode(id: string): boolean {
    const row = this.db.get<Row>('SELECT id FROM node_pool WHERE id = ?', [id])
    if (!row) return false
    this.db.run('DELETE FROM node_pool WHERE id = ?', [id])
    return true
  }

  pinReusableNode(id: string, keepForReprobe: boolean): ReusableNodeEntity | null {
    const row = this.db.get<PoolRow>('SELECT * FROM node_pool WHERE id = ?', [id])
    if (!row) return null
    const entry = this.mapReusableNode(row)
    const decision: ReuseDecision = {
      keepForReprobe,
      qualityScore: entry.qualityScore,
      successStreak: entry.successStreak,
      failStreak: entry.failStreak,
      aliveFailStreak: entry.aliveFailStreak,
      speedFailStreak: entry.speedFailStreak,
      latencyFailStreak: entry.latencyFailStreak,
      poolReason: keepForReprobe ? entry.poolReason ?? 'manual_pin' : 'manual_unpin',
      nextRecheckAt: keepForReprobe ? entry.nextRecheckAt : null
    }
    this.upsertReusableNode(entry, decision)
    return this.getReusableNode(id)
  }

  upsertReusableNode(node: NodeEntity, override?: Partial<ReuseDecision>): ReusableNodeEntity | null {
    const plainNode = this.plainNode(node)
    let existing = this.getReusableNodeByFingerprint(plainNode.fingerprint)
    if (!plainNode.alive) {
      if (existing) this.deleteReusableNode(existing.poolId)
      return null
    }
    if (!existing) {
      const duplicate = this.findReusableDuplicate(plainNode, this.getSettings().dedupe.defaultMode)
      if (duplicate) {
        const keep = this.pickBetterNode(this.extractReusableNode(duplicate), plainNode)
        if (keep.id === duplicate.id) return duplicate
        this.deleteReusableNode(duplicate.poolId)
        existing = null
      }
    }
    const decision = this.buildReuseDecision(plainNode, override, existing ?? undefined)
    if (decision.removeFromPool) {
      if (existing) this.deleteReusableNode(existing.poolId)
      return null
    }
    if (!decision.keepForReprobe && !existing) return null
    const now = nowIso()
    const id = existing?.poolId ?? newId('pool')
    this.db.run(
      `INSERT INTO node_pool
       (id, fingerprint, node_json, quality_score, success_streak, fail_streak,
        alive_fail_streak, speed_fail_streak, latency_fail_streak,
        keep_for_reprobe, pool_reason, last_pool_at, next_recheck_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         node_json = excluded.node_json,
         quality_score = excluded.quality_score,
         success_streak = excluded.success_streak,
         fail_streak = excluded.fail_streak,
         alive_fail_streak = excluded.alive_fail_streak,
         speed_fail_streak = excluded.speed_fail_streak,
         latency_fail_streak = excluded.latency_fail_streak,
         keep_for_reprobe = excluded.keep_for_reprobe,
         pool_reason = excluded.pool_reason,
         last_pool_at = excluded.last_pool_at,
         next_recheck_at = excluded.next_recheck_at,
         updated_at = excluded.updated_at`,
      [
        id,
        plainNode.fingerprint,
        JSON.stringify(plainNode),
        decision.qualityScore,
        decision.successStreak,
        decision.failStreak,
        decision.aliveFailStreak,
        decision.speedFailStreak,
        decision.latencyFailStreak,
        toIntBool(decision.keepForReprobe),
        decision.poolReason,
        now,
        decision.nextRecheckAt,
        existing?.createdAt ?? now,
        now
      ]
    )
    this.trimReusablePool()
    return this.getReusableNodeByFingerprint(node.fingerprint)
  }

  private considerReusableNode(node: NodeEntity, patch: Partial<NodeEntity> = {}): void {
    const existing = this.getReusableNodeByFingerprint(node.fingerprint)
    if (!node.alive) {
      if (existing) this.deleteReusableNode(existing.poolId)
      return
    }
    const override = existing
      ? {
          successStreak: !('alive' in patch) ? existing.successStreak : undefined,
          failStreak:
            !('alive' in patch) &&
            !('speedBps' in patch) &&
            !('speedQualified' in patch) &&
            !('latencyMs' in patch) &&
            !('unlock' in patch)
              ? existing.failStreak
              : undefined,
          aliveFailStreak: !('alive' in patch) ? existing.aliveFailStreak : undefined,
          speedFailStreak:
            !('speedBps' in patch) && !('speedQualified' in patch) ? existing.speedFailStreak : undefined,
          latencyFailStreak: !('latencyMs' in patch) ? existing.latencyFailStreak : undefined
        }
      : undefined
    const decision = this.buildReuseDecision(node, override, existing ?? undefined)
    if (!decision.keepForReprobe && !existing) return
    this.upsertReusableNode(node, decision)
  }

  private findReusableDuplicate(node: NodeEntity, mode: DedupeMode): ReusableNodeEntity | null {
    if (mode === 'normalized_config') return null
    const key = this.dedupeKey(node, mode)
    const rows = this.db.all<PoolRow>('SELECT * FROM node_pool')
    for (const row of rows) {
      const entry = this.mapReusableNode(row)
      if (this.dedupeKey(this.extractReusableNode(entry), mode) === key) return entry
    }
    return null
  }

  private buildReuseDecision(
    node: NodeEntity,
    override: Partial<ReuseDecision> | undefined,
    existing?: ReusableNodeEntity
  ): ReuseDecision {
    const settings = this.getSettings().reusablePool
    const unlockCount = Object.values(node.unlock).filter((item) => item?.available).length
    const speedMBps = node.speedMBps ?? 0
    const latency = node.latencyMs ?? 9999
    const alive = node.alive
    const suspicious = securityRiskOf(node) === 'suspicious'
    const speedMeasured = node.speedBps != null
    const speedFloorOk = !speedMeasured || speedMBps >= settings.absoluteMinSpeedMBps
    const speedOk = !suspicious && speedFloorOk && (node.speedQualified || speedMBps >= settings.minSpeedMBps)
    const latencyOk = node.latencyMs == null || node.latencyMs <= settings.maxLatencyMs
    const aliveFailStreak = override?.aliveFailStreak ?? (alive ? 0 : (existing?.aliveFailStreak ?? existing?.failStreak ?? 0) + 1)
    const speedFailStreak = override?.speedFailStreak ?? (speedOk ? 0 : (existing?.speedFailStreak ?? 0) + 1)
    const latencyFailStreak = override?.latencyFailStreak ?? (latencyOk ? 0 : (existing?.latencyFailStreak ?? 0) + 1)
    const baseScore = Math.round(
      (alive ? 500 : 0) +
        speedMBps * 150 +
        unlockCount * 220 -
        latency / 4 +
        (existing?.successStreak ?? 0) * 30 -
        Math.max(aliveFailStreak, speedFailStreak, latencyFailStreak) * 50 -
        (suspicious ? 1200 : 0)
    )
    const shouldKeepByQuality =
      alive && !suspicious && speedFloorOk && (speedMBps >= settings.minSpeedMBps || latency <= settings.maxLatencyMs || unlockCount > 0 || baseScore >= 700)
    const failStreak = override?.failStreak ?? (shouldKeepByQuality ? 0 : (existing?.failStreak ?? 0) + 1)
    const removeLimit = this.qualityFailureLimit(settings)
    const removeByQuality = removeLimit > 0 && failStreak >= removeLimit
    const removeFromPool = Boolean(existing && removeByQuality)
    const shouldKeepByHistory = Boolean(existing?.keepForReprobe && !removeFromPool)
    const keepForReprobe = removeFromPool
      ? false
      : override?.keepForReprobe ?? (shouldKeepByQuality || shouldKeepByHistory)
    const successStreak = override?.successStreak ?? (alive ? (existing?.successStreak ?? 0) + 1 : 0)
    const qualityScore = override?.qualityScore ?? baseScore
    const nextRecheckAt =
      override?.nextRecheckAt ??
      this.recheckAfterFromScore(qualityScore, alive, speedMBps, latency, unlockCount, keepForReprobe)
    const unlockPlatforms = Object.entries(node.unlock)
      .filter(([, v]) => v?.available)
      .map(([k]) => k)
    const poolReason =
      override?.poolReason ??
      this.describeReuseReason(alive, speedMBps, latency, unlockCount, keepForReprobe, existing, {
        removeByAlive: removeByQuality && !alive,
        removeBySpeed: removeByQuality && alive && !speedFloorOk,
        removeByLatency: removeByQuality && alive && speedFloorOk
      }, unlockPlatforms)
    return {
      keepForReprobe,
      qualityScore,
      successStreak,
      failStreak,
      aliveFailStreak,
      speedFailStreak,
      latencyFailStreak,
      nextRecheckAt,
      poolReason,
      removeFromPool
    }
  }

  private recheckAfterFromScore(
    qualityScore: number,
    alive: boolean,
    speedMBps: number,
    latency: number,
    unlockCount: number,
    keepForReprobe: boolean
  ): string | null {
    if (!keepForReprobe) return null
    const now = Date.now()
    const hours =
      !alive
        ? 6
        : speedMBps >= 10 || unlockCount >= 2
          ? 6
          : speedMBps >= 3 || latency <= 250 || unlockCount >= 1 || qualityScore >= 700
            ? 24
            : 48
    return new Date(now + hours * 60 * 60 * 1000).toISOString()
  }

  private qualityFailureLimit(settings: AppSettings['reusablePool']): number {
    const limits = [
      settings.removeAfterAliveFailures,
      settings.removeAfterSpeedFailures,
      settings.removeAfterLatencyFailures
    ].filter((value) => value > 0)
    return limits.length ? Math.min(...limits) : 0
  }

  private describeReuseReason(
    alive: boolean,
    speedMBps: number,
    latency: number,
    unlockCount: number,
    keepForReprobe: boolean,
    existing?: ReusableNodeEntity,
    removal: { removeByAlive: boolean; removeBySpeed: boolean; removeByLatency: boolean } = {
      removeByAlive: false,
      removeBySpeed: false,
      removeByLatency: false
    },
    unlockPlatforms: string[] = []
  ): string | null {
    if (removal.removeByAlive) return 'removed_alive_failures'
    if (removal.removeBySpeed) return 'removed_speed_failures'
    if (removal.removeByLatency) return 'removed_latency_failures'
    if (!keepForReprobe) {
      if (existing?.keepForReprobe) return 'temporary_recheck'
      return null
    }
    const reasons: string[] = []
    if (speedMBps >= 10) reasons.push('speed_10mbps_plus')
    else if (speedMBps >= 3) reasons.push('speed_3mbps_plus')
    if (latency <= 250) reasons.push('low_latency')
    for (const p of unlockPlatforms) {
      reasons.push(`unlock_${p}`)
    }
    if (reasons.length === 0) {
      reasons.push(alive ? 'alive_recheck' : 'history_recheck')
    }
    return reasons.join('|')
  }

  private trimReusablePool(limit = 800): void {
    const count = Number(this.db.get<Row>('SELECT COUNT(*) AS c FROM node_pool')?.c ?? 0)
    if (count <= limit) return
    const rows = this.db.all<Row>(
      'SELECT id FROM node_pool ORDER BY quality_score ASC, updated_at ASC LIMIT ?',
      [count - limit]
    )
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.run('DELETE FROM node_pool WHERE id = ?', [String(row.id)], false)
      }
    })
  }

  private pruneDeadCurrentNodes(): void {
    this.db.run('DELETE FROM nodes WHERE alive = 0 AND last_tested_at IS NOT NULL')
  }

  private pruneDeadReusableNodes(): void {
    const rows = this.db.all<PoolRow>('SELECT * FROM node_pool')
    const deadIds = rows
      .map((row) => this.mapReusableNode(row))
      .filter((node) => !node.alive)
      .map((node) => node.poolId)
    if (!deadIds.length) return
    this.db.transaction(() => {
      for (const id of deadIds) {
        this.db.run('DELETE FROM node_pool WHERE id = ?', [id], false)
      }
    })
  }

  private sortReusableNodes(
    items: ReusableNodeEntity[],
    sort: string | undefined,
    order: 'asc' | 'desc' | undefined
  ): ReusableNodeEntity[] {
    const sortKey = sort ?? 'quality_score'
    const direction = order === 'asc' ? 1 : -1
    const valueOf = (node: ReusableNodeEntity): string | number | null => {
      if (sortKey === 'alive') return node.alive ? 1 : 0
      if (sortKey === 'speed_bps') return node.speedBps
      if (sortKey === 'latency_ms') return node.latencyMs
      if (sortKey === 'success_streak') return node.successStreak
      if (sortKey === 'fail_streak') return node.failStreak
      if (sortKey === 'country_code') return node.countryCode ?? ''
      if (sortKey === 'updated_at') return node.poolUpdatedAt
      return node.qualityScore
    }
    return [...items].sort((a, b) => {
      const av = valueOf(a)
      const bv = valueOf(b)
      if (av == null && bv == null) return b.poolUpdatedAt.localeCompare(a.poolUpdatedAt)
      if (av == null) return 1
      if (bv == null) return -1
      const primary = typeof av === 'string' || typeof bv === 'string'
        ? String(av).localeCompare(String(bv), 'zh-CN') * direction
        : (Number(av) - Number(bv)) * direction
      return primary || b.poolUpdatedAt.localeCompare(a.poolUpdatedAt)
    })
  }

  private mergeProbeCandidates(candidates: ProbeCandidate[]): ProbeCandidate[] {
    const best = new Map<string, ProbeCandidate>()
    for (const candidate of candidates) {
      const key = candidate.node.fingerprint
      const current = best.get(key)
      if (!current) {
        best.set(key, candidate)
        continue
      }
      if (current.origin === 'pool' && candidate.origin === 'current') {
        best.set(key, candidate)
        continue
      }
      if (current.origin === candidate.origin) {
        const currentScore = this.candidateScore(current)
        const nextScore = this.candidateScore(candidate)
        if (nextScore > currentScore) best.set(key, candidate)
      }
    }
    return [...best.values()]
  }

  private mergeNodesByFingerprint(nodes: NodeEntity[]): NodeEntity[] {
    const best = new Map<string, NodeEntity>()
    for (const node of nodes) {
      const current = best.get(node.fingerprint)
      if (!current || this.nodeScore(node) > this.nodeScore(current)) {
        best.set(node.fingerprint, node)
      }
    }
    return [...best.values()]
  }

  private candidateScore(candidate: ProbeCandidate): number {
    return candidate.origin === 'current'
      ? this.nodeScore(candidate.node) + 50
      : this.nodeScore(candidate.node)
  }

  private nodeScore(node: NodeEntity): number {
    const unlockCount = Object.values(node.unlock).filter((item) => item?.available).length
    return Math.round(
      (node.alive ? 500 : 0) +
        (node.speedMBps ?? 0) * 120 +
        unlockCount * 180 -
        (node.latencyMs ?? 9999) / 4
    )
  }

  dedupe(mode: DedupeMode): { before: number; after: number; removed: number } {
    const nodes = this.getAllNodes()
    const before = nodes.length
    const seen = new Map<string, NodeEntity>()
    const removeIds: string[] = []
    for (const node of nodes) {
      const key = this.dedupeKey(node, mode)
      const previous = seen.get(key)
      if (!previous) {
        seen.set(key, node)
        continue
      }
      const keep = this.pickBetterNode(previous, node)
      const drop = keep.id === previous.id ? node : previous
      seen.set(key, keep)
      removeIds.push(drop.id)
    }
    this.db.transaction(() => {
      for (const id of removeIds) {
        this.db.run('DELETE FROM nodes WHERE id = ?', [id], false)
      }
    })
    const after = Number(this.db.get<Row>('SELECT COUNT(*) AS c FROM nodes')?.c ?? 0)
    return { before, after, removed: before - after }
  }

  createRun(type: RunType, params: Record<string, unknown>): TestRunEntity {
    const id = newId('run')
    const now = nowIso()
    this.db.run(
      `INSERT INTO test_runs
       (id, type, status, params_json, stats_json, created_at)
       VALUES (?, ?, 'queued', ?, '{}', ?)`,
      [id, type, JSON.stringify(params), now]
    )
    this.pruneRuns()
    this.pruneRunsByAge(this.getSettings().schedule.runHistoryRetentionDays)
    return this.getRun(id)!
  }

  updateRun(
    id: string,
    patch: Partial<{
      status: RunStatus
      progress: RunProgress | null
      stats: Record<string, unknown>
      error: string | null
      startedAt: string | null
      finishedAt: string | null
    }>
  ): void {
    const run = this.getRun(id)
    if (!run) return
    this.db.run(
      `UPDATE test_runs
       SET status = ?,
           progress_json = ?,
           stats_json = ?,
           error = ?,
           started_at = ?,
           finished_at = ?
       WHERE id = ?`,
      [
        patch.status ?? run.status,
        patch.progress === undefined ? JSON.stringify(run.progress) : JSON.stringify(patch.progress),
        JSON.stringify(patch.stats ?? run.stats),
        patch.error === undefined ? run.error : patch.error,
        patch.startedAt === undefined ? run.startedAt : patch.startedAt,
        patch.finishedAt === undefined ? run.finishedAt : patch.finishedAt,
        id
      ]
    )
  }

  listRuns(page: number, pageSize: number): PageResult<TestRunEntity> {
    const total = Number(this.db.get<Row>('SELECT COUNT(*) AS c FROM test_runs')?.c ?? 0)
    const rows = this.db.all<Row>(
      'SELECT * FROM test_runs ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [pageSize, (page - 1) * pageSize]
    )
    return {
      items: rows.map((row) => this.mapRun(row)),
      page,
      pageSize,
      total
    }
  }

  getRun(id: string): TestRunEntity | null {
    const row = this.db.get<Row>('SELECT * FROM test_runs WHERE id = ?', [id])
    return row ? this.mapRun(row) : null
  }

  clearRunHistory(): number {
    const row = this.db.get<Row>(
      "SELECT COUNT(*) AS c FROM test_runs WHERE status IN ('success', 'failed', 'cancelled')"
    )
    this.db.run("DELETE FROM test_runs WHERE status IN ('success', 'failed', 'cancelled')")
    return Number(row?.c ?? 0)
  }

  pruneRunsByAge(days: number): number {
    const retentionDays = Math.max(0, Math.floor(Number(days) || 0))
    if (retentionDays <= 0) return 0
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
    const row = this.db.get<Row>(
      "SELECT COUNT(*) AS c FROM test_runs WHERE status IN ('success', 'failed', 'cancelled') AND created_at < ?",
      [cutoff]
    )
    this.db.run(
      "DELETE FROM test_runs WHERE status IN ('success', 'failed', 'cancelled') AND created_at < ?",
      [cutoff]
    )
    return Number(row?.c ?? 0)
  }

  private pruneRuns(limit = 500): void {
    const rows = this.db.all<Row>(
      'SELECT id FROM test_runs ORDER BY created_at DESC LIMIT -1 OFFSET ?',
      [limit]
    )
    if (!rows.length) return
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.run('DELETE FROM test_runs WHERE id = ?', [String(row.id)], false)
      }
    })
  }

  upsertArtifact(input: {
    key: string
    title: string
    format: 'clash' | 'v2ray'
    filePath: string
    publicPath: string
    nodeCount: number
    token: string
  }): ArtifactEntity {
    const id = newId('art')
    const now = nowIso()
    this.db.run(
      `INSERT INTO artifacts (id, key, title, format, file_path, public_path, node_count, token, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         title = excluded.title,
         format = excluded.format,
         file_path = excluded.file_path,
         public_path = excluded.public_path,
         node_count = excluded.node_count,
         token = excluded.token,
         updated_at = excluded.updated_at`,
      [
        id,
        input.key,
        input.title,
        input.format,
        input.filePath,
        input.publicPath,
        input.nodeCount,
        input.token,
        now
      ]
    )
    return this.getArtifactByKey(input.key)!
  }

  listArtifacts(): ArtifactEntity[] {
    return this.db
      .all<Row>('SELECT * FROM artifacts ORDER BY key ASC')
      .map((row) => this.mapArtifact(row))
  }

  getArtifactByKey(key: string): ArtifactEntity | null {
    const row = this.db.get<Row>('SELECT * FROM artifacts WHERE key = ?', [key])
    return row ? this.mapArtifact(row) : null
  }

  getArtifactByPublicPath(publicPath: string): ArtifactEntity | null {
    const row = this.db.get<Row>('SELECT * FROM artifacts WHERE public_path = ?', [publicPath])
    return row ? this.mapArtifact(row) : null
  }

  dashboardSummary(): Record<string, unknown> {
    const lastRun = this.db.get<Row>('SELECT * FROM test_runs ORDER BY created_at DESC LIMIT 1')
    return {
      subscriptions: Number(this.db.get<Row>('SELECT COUNT(*) AS c FROM subscription_sources')?.c ?? 0),
      totalNodes: Number(this.db.get<Row>('SELECT COUNT(*) AS c FROM nodes')?.c ?? 0),
      uniqueNodes: Number(this.db.get<Row>('SELECT COUNT(DISTINCT fingerprint) AS c FROM nodes')?.c ?? 0),
      aliveNodes: Number(this.db.get<Row>('SELECT COUNT(*) AS c FROM nodes WHERE alive = 1')?.c ?? 0),
      speedNodes: Number(this.db.get<Row>('SELECT COUNT(*) AS c FROM nodes WHERE speed_qualified = 1')?.c ?? 0),
      reusableNodes: this.getReusableCount(),
      countries: Number(
        this.db.get<Row>(
          "SELECT COUNT(DISTINCT country_code) AS c FROM nodes WHERE alive = 1 AND country_code IS NOT NULL AND country_code <> ''"
        )?.c ?? 0
      ),
      lastRun: lastRun
        ? {
            id: String(lastRun.id),
            type: String(lastRun.type),
            status: String(lastRun.status),
            finishedAt: lastRun.finished_at ? String(lastRun.finished_at) : null
          }
        : null
    }
  }

  private mapSource(row: Row): SourceEntity {
    return {
      id: String(row.id),
      name: row.name == null ? null : String(row.name),
      url: String(row.url),
      originalUrl: row.original_url == null ? null : String(row.original_url),
      enabled: fromIntBool(row.enabled),
      valid: fromIntBool(row.valid),
      lastFetchAt: row.last_fetch_at == null ? null : String(row.last_fetch_at),
      lastError: row.last_error == null ? null : String(row.last_error),
      lastSuccessAt: row.last_success_at == null ? null : String(row.last_success_at),
      failedFetchCount: Number(row.failed_fetch_count ?? 0),
      autoDeleteFailedFetches:
        row.auto_delete_failed_fetches == null ? null : Number(row.auto_delete_failed_fetches),
      discoveredBy: row.discovered_by == null ? null : String(row.discovered_by),
      contentSignature: row.content_signature == null ? null : String(row.content_signature),
      nodeCount: Number(row.node_count ?? 0),
      typeSummary: safeJsonParse<Record<string, number>>(String(row.type_summary_json ?? '{}'), {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  private mapNode(row: Row): NodeEntity {
    const speedBps = row.speed_bps == null ? null : Number(row.speed_bps)
    const security = safeJsonParse<SecurityCheck>(String(row.security_json ?? '{}'), {
      risk: 'unknown',
      checkedAt: ''
    })
    return {
      id: String(row.id),
      fingerprint: String(row.fingerprint),
      sourceIds: safeJsonParse<string[]>(String(row.source_ids_json ?? '[]'), []),
      protocol: String(row.protocol) as NodeEntity['protocol'],
      originalName: String(row.original_name),
      displayName: String(row.display_name),
      rawUri: row.raw_uri == null ? null : String(row.raw_uri),
      clash: row.clash_json == null ? null : safeJsonParse<Record<string, unknown>>(String(row.clash_json), {}),
      server: String(row.server),
      port: Number(row.port),
      countryCode: row.country_code == null ? null : String(row.country_code),
      countryName: row.country_name == null ? null : String(row.country_name),
      exitIp: row.exit_ip == null ? null : String(row.exit_ip),
      alive: fromIntBool(row.alive),
      latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
      speedBps,
      speedMBps: toMBps(speedBps),
      speedQualified: fromIntBool(row.speed_qualified),
      security: {
        risk: security.risk ?? 'unknown',
        detail: security.detail,
        checkedAt: security.checkedAt || ''
      },
      unlock: safeJsonParse<UnlockMap>(String(row.unlock_json ?? '{}'), {}),
      duplicateGroup: row.duplicate_group == null ? null : String(row.duplicate_group),
      lastTestedAt: row.last_tested_at == null ? null : String(row.last_tested_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  private emptyNodeEntity(): NodeEntity {
    const now = nowIso()
    return {
      id: '',
      fingerprint: '',
      sourceIds: [],
      protocol: 'unknown',
      originalName: '',
      displayName: '',
      rawUri: null,
      clash: null,
      server: '',
      port: 0,
      countryCode: null,
      countryName: null,
      exitIp: null,
      alive: false,
      latencyMs: null,
      speedBps: null,
      speedMBps: null,
      speedQualified: false,
      security: {
        risk: 'unknown',
        checkedAt: ''
      },
      unlock: {},
      duplicateGroup: null,
      lastTestedAt: null,
      createdAt: now,
      updatedAt: now
    }
  }

  private mapReusableNode(row: PoolRow): ReusableNodeEntity {
    const node = safeJsonParse<NodeEntity>(String(row.node_json ?? '{}'), this.emptyNodeEntity())
    const security = node.security ?? { risk: 'unknown' as const, checkedAt: '' }
    return {
      ...node,
      security: {
        risk: security.risk ?? 'unknown',
        detail: security.detail,
        checkedAt: security.checkedAt || ''
      },
      poolId: String(row.id),
      qualityScore: Number(row.quality_score ?? 0),
      successStreak: Number(row.success_streak ?? 0),
      failStreak: Number(row.fail_streak ?? 0),
      aliveFailStreak: Number(row.alive_fail_streak ?? row.fail_streak ?? 0),
      speedFailStreak: Number(row.speed_fail_streak ?? 0),
      latencyFailStreak: Number(row.latency_fail_streak ?? 0),
      keepForReprobe: fromIntBool(row.keep_for_reprobe),
      poolReason: row.pool_reason == null ? null : String(row.pool_reason),
      nextRecheckAt: row.next_recheck_at == null ? null : String(row.next_recheck_at),
      lastPoolAt: row.last_pool_at == null ? null : String(row.last_pool_at),
      poolUpdatedAt: String(row.updated_at)
    }
  }

  private mergeNode(node: NodeEntity, patch: Partial<NodeEntity>): NodeEntity {
    const speedBps = patch.speedBps === undefined ? node.speedBps : patch.speedBps
    return {
      ...node,
      ...patch,
      unlock: patch.unlock ?? node.unlock,
      speedBps,
      speedMBps: speedBps === undefined ? patch.speedMBps ?? node.speedMBps : toMBps(speedBps),
      updatedAt: nowIso()
    }
  }

  private affectsReusableQuality(patch: Partial<NodeEntity>): boolean {
    return (
      'displayName' in patch ||
      'alive' in patch ||
      'latencyMs' in patch ||
      'speedBps' in patch ||
      'speedQualified' in patch ||
      'security' in patch ||
      'countryCode' in patch ||
      'countryName' in patch ||
      'exitIp' in patch ||
      'unlock' in patch
    )
  }

  private plainNode(node: NodeEntity): NodeEntity {
    const {
      poolId: _poolId,
      qualityScore: _qualityScore,
      successStreak: _successStreak,
      failStreak: _failStreak,
      aliveFailStreak: _aliveFailStreak,
      speedFailStreak: _speedFailStreak,
      latencyFailStreak: _latencyFailStreak,
      keepForReprobe: _keepForReprobe,
      poolReason: _poolReason,
      nextRecheckAt: _nextRecheckAt,
      lastPoolAt: _lastPoolAt,
      poolUpdatedAt: _poolUpdatedAt,
      ...plain
    } = node as NodeEntity & Partial<ReusableNodeEntity>
    return plain
  }

  private extractReusableNode(entry: ReusableNodeEntity): NodeEntity {
    return this.plainNode(entry)
  }

  private mapRun(row: Row): TestRunEntity {
    return {
      id: String(row.id),
      type: String(row.type) as TestRunEntity['type'],
      status: String(row.status) as TestRunEntity['status'],
      params: safeJsonParse<Record<string, unknown>>(String(row.params_json ?? '{}'), {}),
      progress: safeJsonParse<RunProgress | null>(
        row.progress_json == null ? null : String(row.progress_json),
        null
      ),
      stats: safeJsonParse<Record<string, unknown>>(String(row.stats_json ?? '{}'), {}),
      error: row.error == null ? null : String(row.error),
      startedAt: row.started_at == null ? null : String(row.started_at),
      finishedAt: row.finished_at == null ? null : String(row.finished_at),
      createdAt: String(row.created_at)
    }
  }

  private mapArtifact(row: Row): ArtifactEntity {
    const publicBaseUrl = this.getSettings().publicBaseUrl.replace(/\/+$/, '')
    return {
      id: String(row.id),
      key: String(row.key),
      title: String(row.title),
      format: String(row.format) as ArtifactEntity['format'],
      filePath: String(row.file_path),
      publicPath: String(row.public_path),
      url: publicBaseUrl ? `${publicBaseUrl}${String(row.public_path)}` : String(row.public_path),
      nodeCount: Number(row.node_count ?? 0),
      token: String(row.token),
      updatedAt: String(row.updated_at)
    }
  }

  private dedupeKey(node: NodeEntity, mode: DedupeMode): string {
    if (mode === 'strict_uri') {
      return sha256(node.rawUri || JSON.stringify(node.clash || {}))
    }
    if (mode === 'endpoint') {
      return `${node.protocol}:${node.server}:${node.port}`.toLowerCase()
    }
    if (mode === 'exit_ip_after_alive') {
      return `${node.protocol}:${node.exitIp || node.server}:${node.countryCode || ''}`.toLowerCase()
    }
    return node.fingerprint
  }

  private dedupeNormalizedNodes(nodes: NormalizedNode[], mode: DedupeMode): NormalizedNode[] {
    const seen = new Map<string, NormalizedNode>()
    for (const node of nodes) {
      const key = this.normalizedNodeDedupeKey(node, mode)
      if (!seen.has(key)) {
        seen.set(key, node)
      }
    }
    return [...seen.values()]
  }

  private normalizedNodeDedupeKey(node: NormalizedNode, mode: DedupeMode): string {
    if (mode === 'strict_uri') {
      return sha256(node.rawUri || JSON.stringify(node.clash || {}))
    }
    if (mode === 'endpoint') {
      return `${node.protocol}:${node.server}:${node.port}`.toLowerCase()
    }
    if (mode === 'exit_ip_after_alive') {
      return `${node.protocol}:${node.server}:${node.port}`.toLowerCase()
    }
    return node.fingerprint
  }

  private pickBetterNode(a: NodeEntity, b: NodeEntity): NodeEntity {
    const score = (node: NodeEntity): number => {
      const securityPenalty = securityRiskOf(node) === 'suspicious' ? 100000 : 0
      return (
        (node.alive ? 10000 : 0) +
        (node.speedBps ?? 0) / 1024 / 1024 +
        Object.values(node.unlock).filter((item) => item?.available).length * 100 -
        (node.latencyMs ?? 9999) / 10 +
        node.sourceIds.length -
        securityPenalty
      )
    }
    return score(b) > score(a) ? b : a
  }
}
