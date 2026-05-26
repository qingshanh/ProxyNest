import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import cron, { type ScheduledTask } from 'node-cron'
import { z } from 'zod'
import { loadConfig } from './config'
import { AppDb } from './db'
import { Store } from './store'
import { SubscriptionService } from './subscriptions'
import { exportClashSubscription, exportV2raySubscription } from './codec'
import { ArtifactService } from './artifacts'
import { TelegramService } from './telegram'
import { GeoIpService } from './geoip'
import { createProbeEngine } from './tester'
import { TaskQueue } from './tasks'
import { HttpError, sendOk } from './utils'
import type { ArtifactEntity, DedupeMode, FullRunParams, ScheduledRunType, UnlockPlatform } from './types'

const cookieName = 'proxynest_session'
const appRoot = path.resolve(__dirname, '../../..')
dotenv.config({ path: path.join(appRoot, '.env') })
dotenv.config()

const bodyOrEmpty = (request: FastifyRequest): Record<string, unknown> => {
  return request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {}
}

const cleanupStaleMihomoWorkDirs = (mihomoDir: string): number => {
  if (!fs.existsSync(mihomoDir)) return 0
  let removed = 0
  for (const entry of fs.readdirSync(mihomoDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^probe(?:_batch)?_/.test(entry.name)) continue
    fs.rmSync(path.join(mihomoDir, entry.name), { recursive: true, force: true })
    removed += 1
  }
  return removed
}

const requestOrigin = (request: FastifyRequest): string => {
  const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim()
  const forwardedHost = String(request.headers['x-forwarded-host'] ?? '').split(',')[0]?.trim()
  const host = forwardedHost || request.headers.host
  if (!host) return ''
  return `${forwardedProto || 'http'}://${host}`
}

const shouldUseRequestOrigin = (publicBaseUrl: string): boolean => {
  const base = publicBaseUrl.trim().replace(/\/+$/, '')
  return !base || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(base)
}

const withRequestArtifactUrls = (
  items: ArtifactEntity[],
  request: FastifyRequest,
  publicBaseUrl: string
): ArtifactEntity[] => {
  if (!shouldUseRequestOrigin(publicBaseUrl)) return items
  const origin = requestOrigin(request)
  if (!origin) return items
  return items.map((artifact) => ({
    ...artifact,
    url: `${origin}${artifact.publicPath}`
  }))
}

const getToken = (request: FastifyRequest): string | null => {
  const cookies = request.cookies as Record<string, string | undefined>
  const cookieToken = cookies[cookieName]
  if (cookieToken) return cookieToken
  const auth = request.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length)
  return null
}

const buildDefaultFullParams = (store: Store, body: Record<string, unknown>): FullRunParams => {
  const settings = store.getSettings()
  const aliveBody = (body.alive as Record<string, unknown> | undefined) ?? {}
  const speedBody = (body.speed as Record<string, unknown> | undefined) ?? {}
  const unlockBody = (body.unlock as Record<string, unknown> | undefined) ?? {}
  const countryBackupBody = (body.countryBackup as Record<string, unknown> | undefined) ?? {}
  return {
    scope: 'all',
    dedupeMode: settings.dedupe.defaultMode,
    alive: {
      enabled: true,
      concurrency: settings.concurrency.aliveRecommended,
      timeoutMs: 8000,
      ...aliveBody
    },
    speed: {
      enabled: true,
      concurrency: settings.concurrency.speedRecommended,
      minMBps: settings.reusablePool.minSpeedMBps,
      targetCount: 50,
      testUrl: 'https://speed.cloudflare.com/__down?bytes=1048576',
      timeoutMs: 8000,
      ...speedBody
    },
    unlock: {
      enabled: true,
      platforms: ['openai', 'youtube', 'netflix', 'disney'],
      concurrency: settings.concurrency.unlockRecommended,
      timeoutMs: 10000,
      ...unlockBody
    },
    countryBackup: {
      enabled: true,
      perCountry: 2,
      ...countryBackupBody
    },
    notifyTelegram: body.notifyTelegram === undefined ? notifyTelegramFor(store, 'full') : Boolean(body.notifyTelegram)
  } as FullRunParams
}

const notifyTelegramFor = (store: Store, type: ScheduledRunType): boolean => {
  const settings = store.getSettings()
  const item = settings.schedule.tasks.find((task) => task.type === type)
  return Boolean(item?.notifyTelegram)
}

const main = async (): Promise<void> => {
  const config = loadConfig()
  cleanupStaleMihomoWorkDirs(config.mihomoDir)
  const db = await AppDb.open(config.dbPath)
  const store = new Store(db, config)
  await store.bootstrap()

  const subscriptions = new SubscriptionService(store, config)
  const artifacts = new ArtifactService(store, config)
  const telegram = new TelegramService(store)
  const geoip = new GeoIpService(config)
  const probe = createProbeEngine(config, () => store.getSettings())
  const tasks = new TaskQueue({ store, subscriptions, artifacts, telegram, geoip, probe })

  const app = Fastify({
    logger: true,
    bodyLimit: config.httpBodyLimitBytes
  })
  let scheduledTasks: ScheduledTask[] = []
  const runGeoIpUpdate = async (): Promise<{ updatedAt: string; bytes?: number; error?: string }> => {
    const settings = store.getSettings()
    try {
      const result = await geoip.updateDatabase(settings.geoip.databaseUrl)
      const latest = store.getSettings()
      store.saveSettings({
        ...latest,
        geoip: {
          ...latest.geoip,
          lastUpdatedAt: result.updatedAt,
          lastUpdateError: null
        }
      })
      app.log.info({ bytes: result.bytes, filePath: result.filePath }, 'GeoIP database updated')
      return { updatedAt: result.updatedAt, bytes: result.bytes }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const latest = store.getSettings()
      store.saveSettings({
        ...latest,
        geoip: {
          ...latest.geoip,
          lastUpdateError: message
        }
      })
      app.log.warn({ error: message }, 'GeoIP database update failed')
      return { updatedAt: new Date().toISOString(), error: message }
    }
  }
  const applySchedule = (): void => {
    for (const task of scheduledTasks) task.stop()
    scheduledTasks = []
    const settings = store.getSettings()
    const configuredItems = settings.schedule.tasks ?? []
    const scheduleItems = configuredItems.some((entry) => entry.enabled)
      ? configuredItems
      : settings.schedule.enabled
        ? [{ id: 'full', type: 'full' as const, enabled: true, cron: settings.schedule.cron, notifyTelegram: true }]
        : configuredItems
    for (const item of scheduleItems.filter((entry) => entry.enabled)) {
      if (!cron.validate(item.cron)) {
        app.log.warn({ id: item.id, type: item.type, cron: item.cron }, 'schedule disabled because cron expression is invalid')
        continue
      }
      scheduledTasks.push(cron.schedule(item.cron, () => {
        const params = buildScheduledRunParams(item.type, item.notifyTelegram)
        const runId = tasks.enqueue(params.type, params.params)
        app.log.info({ runId, scheduleId: item.id, type: item.type, cron: item.cron }, 'scheduled run enqueued')
      }))
    }
    if (settings.geoip.autoUpdate && cron.validate(settings.geoip.updateCron)) {
      scheduledTasks.push(cron.schedule(settings.geoip.updateCron, () => {
        void runGeoIpUpdate()
      }))
    }
  }

  const buildScheduledRunParams = (
    type: ScheduledRunType,
    notifyTelegram = false
  ): { type: 'full' | 'alive' | 'speed' | 'unlock'; params: Record<string, unknown> } => {
    const settings = store.getSettings()
    if (type === 'full') {
      return {
        type: 'full',
        params: buildDefaultFullParams(store, { notifyTelegram }) as unknown as Record<string, unknown>
      }
    }
    if (type === 'pool_alive') {
      return {
        type: 'alive',
        params: {
          scope: 'pool',
          includeAllPool: true,
          concurrency: Math.min(20, settings.concurrency.aliveRecommended),
          timeoutMs: 8000,
          notifyTelegram
        }
      }
    }
    if (type === 'unlock') {
      return {
        type: 'unlock',
        params: {
          scope: 'alive',
          platforms: ['openai', 'youtube', 'netflix', 'disney'] as UnlockPlatform[],
          concurrency: settings.concurrency.unlockRecommended,
          timeoutMs: 10000,
          notifyTelegram
        }
      }
    }
    return {
      type: 'speed',
      params: {
        scope: 'alive',
        concurrency: settings.concurrency.speedRecommended,
        minMBps: settings.reusablePool.minSpeedMBps,
        targetCount: 50,
        testUrl: 'https://speed.cloudflare.com/__down?bytes=1048576',
        timeoutMs: 8000,
        notifyTelegram
      }
    }
  }

  await app.register(cors, {
    origin: true,
    credentials: true
  })
  await app.register(cookie, {
    secret: config.cookieSecret
  })
  const webIndexPath = path.join(config.webDistDir, 'index.html')
  if (fs.existsSync(webIndexPath)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
      decorateReply: false
    })
    app.log.info({ webDistDir: config.webDistDir }, 'web panel static files enabled')
  } else {
    app.log.warn(
      { webDistDir: config.webDistDir, webIndexPath },
      'web panel static files not found; run npm run build:all or set WEB_DIST_DIR'
    )
  }

  app.setErrorHandler((error, _request, reply) => {
    const http = error instanceof HttpError ? error : null
    const statusCode = http?.statusCode ?? 500
    reply.status(statusCode).send({
      ok: false,
      error: {
        code: http?.code ?? 'INTERNAL_ERROR',
        message: http?.message ?? error.message ?? 'Internal error'
      }
    })
  })

  app.addHook('preHandler', async (request, _reply) => {
    const url = request.url
    if (url.startsWith('/sub/')) return
    if (url === '/api/auth/login') return
    if (!url.startsWith('/api/')) return
    const token = getToken(request)
    if (!token || !store.getSessionUser(token)) {
      throw new HttpError(401, 'UNAUTHORIZED', '请先登录')
    }
  })

  app.post('/api/auth/login', async (request, reply) => {
    const schema = z.object({ password: z.string().min(1) })
    const body = schema.parse(request.body)
    const userId = await store.verifyPassword(body.password)
    if (!userId) throw new HttpError(401, 'BAD_PASSWORD', '密码错误')
    const token = store.createSession(userId)
    const settings = store.getSettings()
    reply.setCookie(cookieName, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: settings.auth.sessionTtlDays * 24 * 60 * 60
    })
    return sendOk(reply, { user: { id: userId } })
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = getToken(request)
    if (token) store.deleteSession(token)
    reply.clearCookie(cookieName, { path: '/' })
    return sendOk(reply, true)
  })

  app.get('/api/auth/me', async (request, reply) => {
    const token = getToken(request)
    const user = token ? store.getSessionUser(token) : null
    if (!user) throw new HttpError(401, 'UNAUTHORIZED', '请先登录')
    return sendOk(reply, { user })
  })

  app.post('/api/auth/change-password', async (request, reply) => {
    const schema = z.object({
      oldPassword: z.string().min(1),
      newPassword: z.string().min(6)
    })
    const body = schema.parse(request.body)
    const ok = await store.changePassword(body.oldPassword, body.newPassword)
    if (!ok) throw new HttpError(400, 'BAD_PASSWORD', '旧密码错误')
    reply.clearCookie(cookieName, { path: '/' })
    return sendOk(reply, true)
  })

  app.get('/api/dashboard/summary', async (_request, reply) => {
    return sendOk(reply, store.dashboardSummary())
  })

  app.get('/api/subscriptions', async (_request, reply) => {
    return sendOk(reply, { items: store.listSources() })
  })

  app.post('/api/subscriptions/batch', async (request, reply) => {
    const schema = z.object({
      items: z.array(
        z.object({
          name: z.string().max(200).optional(),
          url: z.string().url().max(4096),
          autoDeleteFailedFetches: z.number().int().min(0).nullable().optional()
        })
      ).min(1).max(config.subscriptionMaxBatchItems),
      dedupeMode: z.enum(['strict_uri', 'normalized_config', 'endpoint', 'exit_ip_after_alive']).default('endpoint')
    })
    const body = schema.parse(request.body)
    const result = await subscriptions.addBatch(body.items, body.dedupeMode as DedupeMode)
    return sendOk(reply, result)
  })

  app.patch('/api/subscriptions/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    const body = z.object({
      name: z.string().optional(),
      enabled: z.boolean().optional(),
      autoDeleteFailedFetches: z.number().int().min(0).nullable().optional()
    }).parse(request.body)
    const source = store.updateSource(params.id, body)
    if (!source) throw new HttpError(404, 'NOT_FOUND', '订阅不存在')
    return sendOk(reply, source)
  })

  app.delete('/api/subscriptions/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    const ok = store.deleteSource(params.id)
    if (!ok) throw new HttpError(404, 'NOT_FOUND', '订阅不存在')
    return sendOk(reply, true)
  })

  app.post('/api/subscriptions/:id/refresh', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    await subscriptions.refreshSource(params.id)
    return sendOk(reply, store.getSource(params.id))
  })

  app.post('/api/subscriptions/refresh-all', async (_request, reply) => {
    const result = await subscriptions.refreshAll()
    return sendOk(reply, result)
  })

  app.post('/api/subscriptions/discover-github', async (request, reply) => {
    const body = z.object({
      searchDays: z.number().int().min(1).max(365).optional(),
      maxRepos: z.number().int().min(1).max(500).optional(),
      maxCandidates: z.number().int().min(1).max(1000).optional(),
      maxAdditions: z.number().int().min(1).max(500).optional(),
      concurrency: z.number().int().min(1).max(50).optional(),
      validateCandidates: z.boolean().optional(),
      queries: z.array(z.string().min(1)).max(50).optional(),
      dedupeMode: z.enum(['strict_uri', 'normalized_config', 'endpoint', 'exit_ip_after_alive']).optional()
    }).parse(request.body ?? {})
    const result = await subscriptions.discoverGithubSources(body)
    return sendOk(reply, result)
  })

  app.get('/api/nodes', async (request, reply) => {
    const query = z.object({
      alive: z.enum(['true', 'false']).optional(),
      protocol: z.string().optional(),
      country: z.string().optional(),
      unlock: z.string().optional(),
      minSpeedMBps: z.coerce.number().optional(),
      sort: z.string().optional(),
      order: z.enum(['asc', 'desc']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(500).default(50)
    }).parse(request.query)
    return sendOk(reply, store.listNodes({
      alive: query.alive == null ? undefined : query.alive === 'true',
      protocol: query.protocol,
      country: query.country,
      unlock: query.unlock,
      minSpeedMBps: query.minSpeedMBps,
      sort: query.sort,
      order: query.order,
      page: query.page,
      pageSize: query.pageSize
    }))
  })

  app.get('/api/nodes/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    const node = store.getNode(params.id)
    if (!node) throw new HttpError(404, 'NOT_FOUND', '节点不存在')
    return sendOk(reply, node)
  })

  app.delete('/api/nodes/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    const ok = store.deleteNode(params.id)
    if (!ok) throw new HttpError(404, 'NOT_FOUND', '节点不存在')
    return sendOk(reply, true)
  })

  app.post('/api/nodes/:id/recheck', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    if (!store.getNode(params.id)) throw new HttpError(404, 'NOT_FOUND', 'node not found')
    const runId = tasks.enqueue('alive', {
      nodeIds: [params.id],
      scope: 'current',
      concurrency: 1,
      timeoutMs: 8000,
      notifyTelegram: notifyTelegramFor(store, 'pool_alive'),
      ...bodyOrEmpty(request)
    }, { priority: 'high' })
    return sendOk(reply, { runId })
  })

  app.post('/api/nodes/:id/speedtest', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    if (!store.getNode(params.id)) throw new HttpError(404, 'NOT_FOUND', 'node not found')
    const settings = store.getSettings()
    const runId = tasks.enqueue('speed', {
      nodeIds: [params.id],
      scope: 'current',
      concurrency: 1,
      minMBps: settings.reusablePool.minSpeedMBps,
      targetCount: 1,
      testUrl: 'https://speed.cloudflare.com/__down?bytes=1048576',
      timeoutMs: 8000,
      notifyTelegram: notifyTelegramFor(store, 'speed'),
      ...bodyOrEmpty(request)
    }, { priority: 'high' })
    return sendOk(reply, { runId })
  })

  app.post('/api/nodes/dedupe', async (request, reply) => {
    const body = z.object({
      mode: z.enum(['strict_uri', 'normalized_config', 'endpoint', 'exit_ip_after_alive'])
    }).parse(request.body)
    return sendOk(reply, store.dedupe(body.mode as DedupeMode))
  })

  app.get('/api/nodes/export', async (request, reply) => {
    const query = z.object({
      alive: z.enum(['true', 'false']).optional(),
      protocol: z.string().optional(),
      country: z.string().optional(),
      minSpeedMBps: z.coerce.number().optional(),
      format: z.enum(['clash', 'v2ray']).default('clash')
    }).parse(request.query)
    const nodes = store.exportNodes({
      alive: query.alive == null ? true : query.alive === 'true',
      protocol: query.protocol,
      country: query.country,
      minSpeedMBps: query.minSpeedMBps
    })
    const content = query.format === 'clash'
      ? exportClashSubscription(nodes)
      : exportV2raySubscription(nodes)
    const filename = `proxynest-nodes.${query.format === 'clash' ? 'yaml' : 'txt'}`
    reply.header('Content-Type', 'application/octet-stream')
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(content)
  })

  app.get('/api/reusable-nodes', async (request, reply) => {
    const query = z.object({
      keepForReprobe: z.enum(['true', 'false']).optional(),
      country: z.string().optional(),
      sort: z.string().optional(),
      order: z.enum(['asc', 'desc']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(500).default(50)
    }).parse(request.query)
    return sendOk(reply, store.listReusableNodes({
      keepForReprobe: query.keepForReprobe == null ? undefined : query.keepForReprobe === 'true',
      country: query.country,
      sort: query.sort,
      order: query.order,
      page: query.page,
      pageSize: query.pageSize
    }))
  })

  app.get('/api/reusable-nodes/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    const node = store.getReusableNode(params.id)
    if (!node) throw new HttpError(404, 'NOT_FOUND', '优质节点不存在')
    return sendOk(reply, node)
  })

  app.patch('/api/reusable-nodes/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    const body = z.object({
      keepForReprobe: z.boolean()
    }).parse(request.body)
    const node = store.pinReusableNode(params.id, body.keepForReprobe)
    if (!node) throw new HttpError(404, 'NOT_FOUND', '优质节点不存在')
    return sendOk(reply, node)
  })

  app.delete('/api/reusable-nodes/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    const ok = store.deleteReusableNode(params.id)
    if (!ok) throw new HttpError(404, 'NOT_FOUND', '优质节点不存在')
    return sendOk(reply, true)
  })

  app.post('/api/reusable-nodes/:id/recheck', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    if (!store.getReusableNode(params.id)) throw new HttpError(404, 'NOT_FOUND', '优质节点不存在')
    const settings = store.getSettings()
    const runId = tasks.enqueue('alive', {
      poolIds: [params.id],
      includeAllPool: true,
      concurrency: Math.min(10, settings.concurrency.aliveRecommended),
      timeoutMs: 8000,
      notifyTelegram: notifyTelegramFor(store, 'pool_alive'),
      ...bodyOrEmpty(request)
    }, { priority: 'high' })
    return sendOk(reply, { runId })
  })

  app.get('/api/reusable-nodes/export', async (request, reply) => {
    const query = z.object({
      keepForReprobe: z.enum(['true', 'false']).optional(),
      country: z.string().optional(),
      format: z.enum(['clash', 'v2ray']).default('clash')
    }).parse(request.query)
    const nodes = store.exportReusableNodes({
      keepForReprobe: query.keepForReprobe == null ? undefined : query.keepForReprobe === 'true',
      country: query.country
    })
    const content = query.format === 'clash'
      ? exportClashSubscription(nodes)
      : exportV2raySubscription(nodes)
    const filename = `proxynest-reusable.${query.format === 'clash' ? 'yaml' : 'txt'}`
    reply.header('Content-Type', 'application/octet-stream')
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(content)
  })

  app.post('/api/runs/full', async (request, reply) => {
    const runId = tasks.enqueue('full', buildDefaultFullParams(store, bodyOrEmpty(request)) as unknown as Record<string, unknown>)
    return sendOk(reply, { runId })
  })

  app.post('/api/runs/alive', async (request, reply) => {
    const settings = store.getSettings()
    const body = {
      scope: 'all',
      concurrency: settings.concurrency.aliveRecommended,
      timeoutMs: 8000,
      notifyTelegram: notifyTelegramFor(store, 'pool_alive'),
      ...bodyOrEmpty(request)
    }
    const runId = tasks.enqueue('alive', body)
    return sendOk(reply, { runId })
  })

  app.post('/api/runs/speed', async (request, reply) => {
    const settings = store.getSettings()
    const body = {
      scope: 'alive',
      concurrency: settings.concurrency.speedRecommended,
      minMBps: settings.reusablePool.minSpeedMBps,
      targetCount: 50,
      testUrl: 'https://speed.cloudflare.com/__down?bytes=1048576',
      timeoutMs: 8000,
      notifyTelegram: notifyTelegramFor(store, 'speed'),
      ...bodyOrEmpty(request)
    }
    const runId = tasks.enqueue('speed', body)
    return sendOk(reply, { runId })
  })

  app.post('/api/runs/unlock', async (request, reply) => {
    const settings = store.getSettings()
    const body = {
      scope: 'alive',
      platforms: ['openai', 'youtube', 'netflix', 'disney'] as UnlockPlatform[],
      concurrency: settings.concurrency.unlockRecommended,
      timeoutMs: 10000,
      notifyTelegram: notifyTelegramFor(store, 'unlock'),
      ...bodyOrEmpty(request)
    }
    const runId = tasks.enqueue('unlock', body)
    return sendOk(reply, { runId })
  })

  app.post('/api/runs/country-backup', async (request, reply) => {
    const body = {
      perCountry: 2,
      notifyTelegram: notifyTelegramFor(store, 'full'),
      ...bodyOrEmpty(request)
    }
    const runId = tasks.enqueue('country_backup', body)
    return sendOk(reply, { runId })
  })

  app.get('/api/runs', async (request, reply) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20)
    }).parse(request.query)
    return sendOk(reply, store.listRuns(query.page, query.pageSize))
  })

  app.delete('/api/runs/history', async (_request, reply) => {
    return sendOk(reply, { deleted: store.clearRunHistory() })
  })

  app.get('/api/runs/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    const run = store.getRun(params.id)
    if (!run) throw new HttpError(404, 'NOT_FOUND', '任务不存在')
    return sendOk(reply, run)
  })

  app.post('/api/runs/:id/cancel', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    const ok = tasks.cancel(params.id)
    if (!ok) throw new HttpError(404, 'NOT_FOUND', '任务不存在或已结束')
    return sendOk(reply, true)
  })

  app.post('/api/runs/:id/pause', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    const ok = tasks.pause(params.id)
    if (!ok) throw new HttpError(404, 'NOT_FOUND', '任务不存在或不可暂停')
    return sendOk(reply, true)
  })

  app.post('/api/runs/:id/resume', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    const ok = tasks.resume(params.id)
    if (!ok) throw new HttpError(404, 'NOT_FOUND', '任务不存在或不可继续')
    return sendOk(reply, true)
  })

  app.get('/api/runs/:id/events', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params)
    const run = store.getRun(params.id)
    if (!run) throw new HttpError(404, 'NOT_FOUND', '任务不存在')
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    })
    let closed = false
    let unsubscribe: () => void = () => undefined
    let subscribed = false
    let cleanupAfterSubscribe = false
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(': ping\n\n')
    }, 30000)
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      if (subscribed) {
        unsubscribe()
      } else {
        cleanupAfterSubscribe = true
      }
    }
    const write = (progress: unknown) => {
      if (closed) return
      reply.raw.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`)
      if (
        progress &&
        typeof progress === 'object' &&
        ['success', 'failed', 'cancelled'].includes(String((progress as { status?: unknown }).status))
      ) {
        cleanup()
        reply.raw.end()
      }
    }
    unsubscribe = tasks.subscribe(params.id, write)
    subscribed = true
    if (cleanupAfterSubscribe) unsubscribe()
    request.raw.on('close', cleanup)
  })

  app.get('/api/artifacts', async (request, reply) => {
    return sendOk(reply, {
      items: withRequestArtifactUrls(store.listArtifacts(), request, store.getSettings().publicBaseUrl)
    })
  })

  app.get('/api/settings', async (_request, reply) => {
    return sendOk(reply, store.getPublicSettings())
  })

  app.patch('/api/settings', async (request, reply) => {
    const body = bodyOrEmpty(request)
    const schedule = body.schedule as Record<string, unknown> | undefined
    const nextScheduleEnabled =
      schedule?.enabled === undefined ? store.getSettings().schedule.enabled : Boolean(schedule.enabled)
    const nextCron =
      typeof schedule?.cron === 'string' ? schedule.cron : store.getSettings().schedule.cron
    if (nextScheduleEnabled && !cron.validate(nextCron)) {
      throw new HttpError(400, 'BAD_CRON', '定时任务 cron 表达式无效')
    }
    if (schedule && Object.prototype.hasOwnProperty.call(schedule, 'tasks') && !Array.isArray(schedule.tasks)) {
      throw new HttpError(400, 'BAD_SCHEDULE', '定时任务列表必须是数组')
    }
    if (Array.isArray(schedule?.tasks)) {
      for (const item of schedule.tasks) {
        const entry = item as Record<string, unknown>
        if (entry.enabled && typeof entry.cron === 'string' && !cron.validate(entry.cron)) {
          throw new HttpError(400, 'BAD_CRON', `定时任务 ${String(entry.id ?? '')} cron 表达式无效`)
        }
      }
    }
    if (
      schedule &&
      Object.prototype.hasOwnProperty.call(schedule, 'runHistoryRetentionDays') &&
      (
        !Number.isFinite(Number(schedule.runHistoryRetentionDays)) ||
        Number(schedule.runHistoryRetentionDays) < 0
      )
    ) {
      throw new HttpError(400, 'BAD_HISTORY_RETENTION', '历史任务保留天数必须是 0 或正数')
    }
    const geoipPatch = body.geoip as Record<string, unknown> | undefined
    if (geoipPatch?.updateCron && !cron.validate(String(geoipPatch.updateCron))) {
      throw new HttpError(400, 'BAD_CRON', 'GeoIP 更新 cron 表达式无效')
    }
    const next = store.patchSettings(body)
    store.pruneRunsByAge(next.schedule.runHistoryRetentionDays)
    applySchedule()
    return sendOk(reply, {
      ...store.getPublicSettings(),
      telegram: {
        ...next.telegram,
        botToken: undefined,
        botTokenSet: Boolean(next.telegram.botToken)
      }
    })
  })

  app.post('/api/settings/sub-token/regenerate', async (request, reply) => {
    store.regenerateSubToken()
    artifacts.generateStandardArtifacts()
    return sendOk(reply, {
      items: withRequestArtifactUrls(store.listArtifacts(), request, store.getSettings().publicBaseUrl)
    })
  })

  app.post('/api/settings/telegram/test', async (_request, reply) => {
    await telegram.sendTest()
    return sendOk(reply, true)
  })

  app.post('/api/settings/geoip/update', async (_request, reply) => {
    const result = await runGeoIpUpdate()
    if (result.error) throw new HttpError(502, 'GEOIP_UPDATE_FAILED', result.error)
    return sendOk(reply, {
      ...result,
      settings: store.getPublicSettings()
    })
  })

  app.get('/sub/:token/*', async (request, reply) => {
    const params = z.object({
      token: z.string(),
      '*': z.string()
    }).parse(request.params)
    const artifact = artifacts.readPublicArtifact(params.token, params['*'])
    if (!artifact) throw new HttpError(404, 'NOT_FOUND', 'Not found')
    reply.header('Content-Type', artifact.contentType)
    return reply.send(fs.createReadStream(artifact.filePath))
  })

  app.setNotFoundHandler((request, reply) => {
    if (
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      !request.url.startsWith('/sub/') &&
      fs.existsSync(webIndexPath)
    ) {
      return reply.type('text/html; charset=utf-8').send(fs.createReadStream(webIndexPath))
    }
    return reply.status(404).send({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Not found'
      }
    })
  })

  const close = async () => {
    for (const task of scheduledTasks) task.stop()
    await app.close()
    db.close()
    process.exit(0)
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)

  applySchedule()
  await app.listen({ host: config.host, port: config.port })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
