import path from 'node:path'
import fs from 'node:fs'

const appRoot = path.resolve(__dirname, '../../..')

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = int(value, fallback)
  return parsed > 0 ? parsed : fallback
}

const resolveAppPath = (value: string | undefined, fallback: string): string => {
  const target = value || fallback
  return path.isAbsolute(target) ? target : path.resolve(appRoot, target)
}

const resolveOptionalAppPath = (value: string | undefined): string => {
  const trimmed = String(value ?? '').trim().replace(/^["']|["']$/g, '')
  if (!trimmed) return ''
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(appRoot, trimmed)
}

const mihomoCandidateNames = (): string[] => {
  return process.platform === 'win32' ? ['mihomo.exe', 'mihomo'] : ['mihomo', 'mihomo.exe']
}

const resolveMihomoBin = (value: string | undefined): string => {
  const configured = resolveOptionalAppPath(value)
  if (configured && fs.existsSync(configured)) return configured
  for (const name of mihomoCandidateNames()) {
    const candidate = path.resolve(appRoot, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return configured
}

export type AppConfig = {
  host: string
  port: number
  dataDir: string
  dbPath: string
  artifactsDir: string
  mihomoDir: string
  webDistDir: string
  publicBaseUrl: string
  adminPassword: string
  cookieSecret: string
  sessionTtlDays: number
  mihomoBin: string
  mihomoApiSecret: string
  mihomoBasePort: number
  mihomoBaseControllerPort: number
  telegramEnabled: boolean
  telegramBotToken: string
  telegramChatId: string
  telegramApiBaseUrl: string
  githubToken: string
  githubApiBaseUrl: string
  githubRawProxyPrefix: string
  httpBodyLimitBytes: number
  subscriptionMaxBatchItems: number
  subscriptionMaxBytes: number
  subscriptionMaxNodesPerSource: number
  subscriptionMaxNodesPerBatch: number
}

export const loadConfig = (): AppConfig => {
  const dataDir = resolveAppPath(process.env.DATA_DIR, './data')
  const defaultDbPath = path.join(dataDir, 'proxynest.db')
  const legacyDbPath = path.join(dataDir, 'bestsub.db')
  const dbPath = process.env.DB_PATH
    ? resolveAppPath(process.env.DB_PATH, defaultDbPath)
    : (!fs.existsSync(defaultDbPath) && fs.existsSync(legacyDbPath) ? legacyDbPath : defaultDbPath)
  return {
    host: process.env.HOST || '0.0.0.0',
    port: int(process.env.PORT, 8080),
    dataDir,
    dbPath,
    artifactsDir: path.join(dataDir, 'artifacts'),
    mihomoDir: path.join(dataDir, 'mihomo'),
    webDistDir: resolveAppPath(process.env.WEB_DIST_DIR, './apps/web/dist'),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    adminPassword: process.env.ADMIN_PASSWORD || 'change-me-before-start',
    cookieSecret: process.env.COOKIE_SECRET || 'change-me-to-a-long-random-string',
    sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),
    mihomoBin: resolveMihomoBin(process.env.MIHOMO_BIN),
    mihomoApiSecret: process.env.MIHOMO_API_SECRET || 'proxynest',
    mihomoBasePort: int(process.env.MIHOMO_BASE_PORT, 17890),
    mihomoBaseControllerPort: int(process.env.MIHOMO_BASE_CONTROLLER_PORT, 17990),
    telegramEnabled: bool(process.env.TELEGRAM_ENABLED, false),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    telegramApiBaseUrl: process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org',
    githubToken: process.env.GITHUB_TOKEN || '',
    githubApiBaseUrl: process.env.GITHUB_API_BASE_URL || 'https://api.github.com',
    githubRawProxyPrefix: process.env.GITHUB_RAW_PROXY_PREFIX || '',
    httpBodyLimitBytes: positiveInt(process.env.HTTP_BODY_LIMIT_BYTES, 4 * 1024 * 1024),
    subscriptionMaxBatchItems: positiveInt(process.env.SUBSCRIPTION_MAX_BATCH_ITEMS, 200),
    subscriptionMaxBytes: positiveInt(process.env.SUBSCRIPTION_MAX_BYTES, 8 * 1024 * 1024),
    subscriptionMaxNodesPerSource: positiveInt(process.env.SUBSCRIPTION_MAX_NODES_PER_SOURCE, 20000),
    subscriptionMaxNodesPerBatch: positiveInt(process.env.SUBSCRIPTION_MAX_NODES_PER_BATCH, 50000)
  }
}
