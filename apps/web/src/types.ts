export type ApiResponse<T> = {
  ok: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
}

export type PageResult<T> = {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export type ProxyProtocol =
  | 'vmess'
  | 'vless'
  | 'trojan'
  | 'ss'
  | 'ssr'
  | 'hysteria2'
  | 'hysteria'
  | 'tuic'
  | 'snell'
  | 'http'
  | 'socks5'
  | 'anytls'
  | 'unknown'
export type DedupeMode = 'strict_uri' | 'normalized_config' | 'endpoint' | 'exit_ip_after_alive'
export type UnlockPlatform = 'openai' | 'youtube' | 'netflix' | 'disney'
export type RunType = 'fetch' | 'alive' | 'speed' | 'unlock' | 'country_backup' | 'full'
export type ScheduledRunType = 'full' | 'pool_alive' | 'speed' | 'unlock'
export type RunStatus = 'queued' | 'running' | 'paused' | 'success' | 'failed' | 'cancelled'
export type RunStage = 'discover' | 'fetch' | 'dedupe' | 'alive' | 'speed' | 'unlock' | 'country_backup' | 'artifact' | 'notify'

export type UnlockMap = Partial<Record<UnlockPlatform, { available: boolean; region?: string; detail?: string; checkedAt: string }>>
export type SecurityRiskLevel = 'unknown' | 'safe' | 'suspicious'
export type SecurityCheck = { risk: SecurityRiskLevel; detail?: string; checkedAt: string }

export type SourceEntity = {
  id: string
  name: string | null
  url: string
  originalUrl: string | null
  enabled: boolean
  valid: boolean
  lastFetchAt: string | null
  lastError: string | null
  lastSuccessAt: string | null
  failedFetchCount: number
  autoDeleteFailedFetches: number | null
  discoveredBy: string | null
  contentSignature: string | null
  nodeCount: number
  typeSummary: Record<string, number>
  createdAt: string
  updatedAt: string
}

export type NodeEntity = {
  id: string
  fingerprint: string
  sourceIds: string[]
  protocol: ProxyProtocol
  originalName: string
  displayName: string
  rawUri: string | null
  clash: Record<string, unknown> | null
  server: string
  port: number
  countryCode: string | null
  countryName: string | null
  exitIp: string | null
  alive: boolean
  latencyMs: number | null
  speedBps: number | null
  speedMBps: number | null
  speedQualified: boolean
  security: SecurityCheck
  unlock: UnlockMap
  duplicateGroup: string | null
  lastTestedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ProbeCandidateOrigin = 'current' | 'pool'

export type ProbeCandidate = {
  origin: ProbeCandidateOrigin
  node: NodeEntity
  poolId?: string
}

export type ReusableNodeEntity = NodeEntity & {
  poolId: string
  qualityScore: number
  successStreak: number
  failStreak: number
  aliveFailStreak: number
  speedFailStreak: number
  latencyFailStreak: number
  keepForReprobe: boolean
  poolReason: string | null
  nextRecheckAt: string | null
  lastPoolAt: string | null
  poolUpdatedAt: string
}

export type ArtifactEntity = {
  id: string
  key: string
  title: string
  format: 'clash' | 'v2ray'
  filePath: string
  publicPath: string
  url: string
  nodeCount: number
  token: string
  updatedAt: string
}

export type TestRunEntity = {
  id: string
  type: RunType
  status: RunStatus
  params: Record<string, unknown>
  progress: RunProgress | null
  stats: Record<string, unknown>
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export type RunProgress = {
  runId: string
  status: RunStatus
  stage?: RunStage
  current?: number
  total?: number
  message?: string
  stats?: Record<string, unknown>
  active?: RunProgressNode[]
  recent?: RunProgressNode[]
}

export type RunProgressNode = {
  id: string
  name: string
  protocol: ProxyProtocol
  server: string
  port: number
  origin?: string
  action: string
  status: 'running' | 'success' | 'failed' | 'skipped'
  alive?: boolean
  latencyMs?: number | null
  speedMBps?: number | null
  platform?: UnlockPlatform
  unlockAvailable?: boolean
  region?: string | null
  detail?: string
  updatedAt: string
}

export type AppSettings = {
  auth: { sessionTtlDays: number }
  dedupe: { defaultMode: DedupeMode }
  subscriptions: { autoDeleteFailedFetches: number }
  unlockTest: Record<UnlockPlatform, string>
  geoip: {
    mode: 'local_with_api_fallback' | 'local_only' | 'api_only'
    apiUrl: string
    databaseUrl: string
    autoUpdate: boolean
    updateCron: string
    lastUpdatedAt: string | null
    lastUpdateError: string | null
  }
  github: {
    rawProxyPrefix: string
    apiBaseUrl: string
    tokenSet: boolean
    discovery: {
      enabled: boolean
      searchDays: number
      maxRepos: number
      maxCandidates: number
      maxAdditions: number
      concurrency: number
      validateCandidates: boolean
      queries: string[]
    }
  }
  concurrency: { aliveRecommended: number; speedRecommended: number; unlockRecommended: number }
  reusablePool: {
    absoluteMinSpeedMBps: number
    minSpeedMBps: number
    maxLatencyMs: number
    removeAfterAliveFailures: number
    removeAfterSpeedFailures: number
    removeAfterLatencyFailures: number
  }
  telegram: { enabled: boolean; botTokenSet: boolean; chatId: string; apiBaseUrl: string }
  mihomo: { bin: string; configured: boolean; exists: boolean }
  schedule: {
    enabled: boolean
    cron: string
    runHistoryRetentionDays: number
    tasks: Array<{
      id: string
      type: ScheduledRunType
      enabled: boolean
      cron: string
      notifyTelegram?: boolean
    }>
  }
  publicBaseUrl: string
  subTokenSet: boolean
}

export type DashboardSummary = {
  subscriptions: number
  totalNodes: number
  uniqueNodes: number
  aliveNodes: number
  speedNodes: number
  reusableNodes: number
  countries: number
  lastRun: {
    id: string
    type: string
    status: string
    finishedAt: string | null
  } | null
}

export type FullRunParams = {
  scope: 'all' | 'alive'
  dedupeMode: DedupeMode
  alive: { enabled: boolean; concurrency: number; timeoutMs: number }
  speed: { enabled: boolean; concurrency: number; minMBps: number; targetCount: number; testUrl: string; timeoutMs: number }
  unlock: { enabled: boolean; platforms: UnlockPlatform[]; concurrency: number; timeoutMs: number }
  countryBackup: { enabled: boolean; perCountry: number }
  notifyTelegram: boolean
}

export type GithubDiscoveryResult = {
  searchedRepos: number
  candidateUrls: number
  validUrls: number
  added: number
  skippedExisting: number
  failed: Array<{ url: string; error: string }>
  sources: SourceEntity[]
  sourceDedupe?: { before: number; after: number; removed: number }
}

export type DirectoryDiscoveryResult = {
  searchedPages: number
  candidateUrls: number
  validUrls: number
  added: number
  skippedExisting: number
  failed: Array<{ url: string; error: string }>
  sources: SourceEntity[]
  sourceDedupe?: { before: number; after: number; removed: number }
}
