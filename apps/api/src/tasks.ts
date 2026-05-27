import { EventEmitter } from 'node:events'
import net from 'node:net'
import type { ArtifactService } from './artifacts'
import type { GeoIpService } from './geoip'
import { inferCountryFromText } from './geoip'
import type { ProbeEngine } from './tester'
import type { SubscriptionService } from './subscriptions'
import type { TelegramService } from './telegram'
import type {
  FullRunParams,
  NodeEntity,
  ProbeCandidate,
  RunProgress,
  RunProgressNode,
  RunStatus,
  RunType,
  TestRunEntity,
  UnlockMap,
  UnlockPlatform
} from './types'
import type { Store } from './store'
import { nowIso, runLimited, toMBps } from './utils'

type QueueItem = {
  runId: string
  type: RunType
  params: Record<string, unknown>
}

type EnqueueOptions = {
  priority?: 'normal' | 'high'
}

type Services = {
  store: Store
  subscriptions: SubscriptionService
  artifacts: ArtifactService
  telegram: TelegramService
  geoip: GeoIpService
  probe: ProbeEngine
}

type NodeProbePatch = Parameters<Store['updateNodeProbe']>[1]

class TaskCancelledError extends Error {
  constructor() {
    super('任务已取消')
    this.name = 'TaskCancelledError'
  }
}

export class TaskQueue {
  private readonly events = new EventEmitter()
  private readonly queue: QueueItem[] = []
  private readonly cancelled = new Set<string>()
  private readonly paused = new Set<string>()
  private readonly pauseWaiters = new Map<string, Array<() => void>>()
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly progressFlushes = new Map<string, { at: number; key: string }>()
  private readonly progressDetails = new Map<string, { active: Map<string, RunProgressNode>; recent: RunProgressNode[] }>()
  private readonly progressThrottleMs = 500
  private running = false

  constructor(private readonly services: Services) {
    this.events.setMaxListeners(1000)
  }

  enqueue(type: RunType, params: Record<string, unknown>, options: EnqueueOptions = {}): string {
    const run = this.services.store.createRun(type, params)
    const item = { runId: run.id, type, params }
    if (options.priority === 'high') {
      if (this.running) {
        void this.execute(item)
        return run.id
      }
      this.queue.unshift(item)
    } else {
      this.queue.push(item)
    }
    void this.drain()
    return run.id
  }

  cancel(runId: string): boolean {
    const run = this.services.store.getRun(runId)
    if (!run || ['success', 'failed', 'cancelled'].includes(run.status)) return false
    this.cancelled.add(runId)
    this.resumePausedWaiters(runId)
    this.abortControllers.get(runId)?.abort()
    this.services.store.updateRun(runId, {
      status: 'cancelled',
      finishedAt: nowIso(),
      progress: {
        ...(run.progress ?? {}),
        runId,
        status: 'cancelled',
        message: run.status === 'queued' ? '任务已取消' : '正在取消任务'
      }
    })
    this.emit(runId)
    return true
  }

  pause(runId: string): boolean {
    const run = this.services.store.getRun(runId)
    if (!run || !['queued', 'running', 'paused'].includes(run.status)) return false
    if (run.status === 'paused') return true
    this.paused.add(runId)
    this.services.store.updateRun(runId, {
      status: 'paused',
      progress: {
        ...(run.progress ?? {}),
        runId,
        status: 'paused',
        message: run.status === 'queued' ? '任务已暂停，等待继续' : '任务已暂停'
      }
    })
    this.emit(runId)
    return true
  }

  resume(runId: string): boolean {
    const run = this.services.store.getRun(runId)
    if (!run || run.status !== 'paused') return false
    this.paused.delete(runId)
    this.resumePausedWaiters(runId)
    const nextStatus: RunStatus = run.startedAt ? 'running' : 'queued'
    this.services.store.updateRun(runId, {
      status: nextStatus,
      progress: {
        ...(run.progress ?? {}),
        runId,
        status: nextStatus,
        message: '任务继续'
      }
    })
    this.emit(runId)
    void this.drain()
    return true
  }

  subscribe(runId: string, listener: (progress: RunProgress) => void): () => void {
    const event = `run:${runId}`
    this.events.on(event, listener)
    const run = this.services.store.getRun(runId)
    if (run?.progress) listener(run.progress)
    return () => {
      this.events.off(event, listener)
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!
        const current = this.services.store.getRun(item.runId)
        if (!current || current.status === 'cancelled') continue
        if (this.paused.has(item.runId) || current.status === 'paused') {
          this.paused.add(item.runId)
          await this.waitWhilePaused(item.runId)
          if (this.cancelled.has(item.runId)) continue
        }
        await this.execute(item)
      }
    } finally {
      this.running = false
    }
  }

  private async execute(item: QueueItem): Promise<void> {
    const startedAt = nowIso()
    const controller = new AbortController()
    this.abortControllers.set(item.runId, controller)
    this.services.store.updateRun(item.runId, {
      status: 'running',
      startedAt,
      progress: {
        runId: item.runId,
        status: 'running',
        message: '任务开始'
      }
    })
    this.emit(item.runId)
    try {
      if (item.type === 'full') {
        await this.pausePoint(item.runId)
        await this.runFull(item.runId, item.params as unknown as FullRunParams)
      } else if (item.type === 'alive') {
        await this.pausePoint(item.runId)
        await this.runAlive(item.runId, item.params)
        this.services.artifacts.generateStandardArtifacts()
      } else if (item.type === 'speed') {
        await this.pausePoint(item.runId)
        await this.runSpeed(item.runId, item.params)
        this.services.artifacts.generateStandardArtifacts()
      } else if (item.type === 'unlock') {
        await this.pausePoint(item.runId)
        await this.runUnlock(item.runId, item.params)
        this.services.artifacts.generateStandardArtifacts()
      } else if (item.type === 'country_backup') {
        this.progress(item.runId, 'running', 'country_backup', 1, 1, '生成国家备用订阅')
        this.services.artifacts.generateStandardArtifacts(Number(item.params.perCountry ?? 2))
      } else if (item.type === 'fetch') {
        await this.runFetch(item.runId)
      }
      this.ensureNotCancelled(item.runId)
      const existingStats = this.services.store.getRun(item.runId)?.stats ?? {}
      const stats = {
        ...existingStats,
        ...this.services.store.dashboardSummary()
      }
      this.services.store.updateRun(item.runId, {
        status: 'success',
        finishedAt: nowIso(),
        stats,
        progress: {
          runId: item.runId,
          status: 'success',
          message: '任务完成',
          stats,
          ...this.progressDetailSnapshot(item.runId)
        }
      })
      this.emit(item.runId)
      if (Boolean(item.params.notifyTelegram)) {
        try {
          const telegramResult = await this.services.telegram.sendRunSummary(item.runId)
          if (!telegramResult.sent) {
            this.patchStats(item.runId, { telegram: telegramResult })
          }
        } catch (notifyError) {
          this.patchStats(item.runId, {
            telegram: {
              sent: false,
              error: notifyError instanceof Error ? notifyError.message : String(notifyError)
            }
          })
        }
      }
    } catch (error) {
      const cancelled = this.isCancelled(item.runId, error)
      if (!cancelled) this.generateArtifactsAfterPartialRun(item.type)
      const previousProgress = this.services.store.getRun(item.runId)?.progress
      const message = cancelled ? '任务已取消' : error instanceof Error ? error.message : String(error)
      this.services.store.updateRun(item.runId, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : message,
        finishedAt: nowIso(),
        progress: {
          ...(previousProgress ?? {}),
          runId: item.runId,
          status: cancelled ? 'cancelled' : 'failed',
          message
        }
      })
      this.emit(item.runId)
    } finally {
      this.abortControllers.delete(item.runId)
      this.cancelled.delete(item.runId)
      this.paused.delete(item.runId)
      this.resumePausedWaiters(item.runId)
      this.progressFlushes.delete(item.runId)
      this.progressDetails.delete(item.runId)
    }
  }

  private async runFull(runId: string, params: FullRunParams): Promise<void> {
    await this.pausePoint(runId)
    await this.runFetch(runId)
    this.ensureNotCancelled(runId)
    await this.pausePoint(runId)
    this.progress(runId, 'running', 'dedupe', 1, 1, '节点去重')
    const dedupe = this.services.store.dedupe(params.dedupeMode)
    this.patchStats(runId, { dedupe })
    let aliveCandidates: ProbeCandidate[] | undefined
    if (params.alive.enabled) {
      await this.pausePoint(runId)
      aliveCandidates = await this.runAlive(runId, { ...params.alive, includeAllPool: true })
    }
    if (params.speed.enabled) {
      await this.pausePoint(runId)
      aliveCandidates = await this.runSpeed(runId, params.speed, aliveCandidates)
    }
    if (params.unlock.enabled) {
      await this.pausePoint(runId)
      await this.runUnlock(runId, params.unlock, aliveCandidates)
    }
    if (params.countryBackup.enabled) {
      await this.pausePoint(runId)
      this.progress(runId, 'running', 'country_backup', 1, 1, '生成国家备用节点')
      this.services.artifacts.generateStandardArtifacts(params.countryBackup.perCountry)
    } else {
      this.progress(runId, 'running', 'artifact', 1, 1, '生成订阅')
      this.services.artifacts.generateStandardArtifacts()
    }
  }

  private async runFetch(runId: string): Promise<void> {
    const settings = this.services.store.getSettings()
    await this.pausePoint(runId)
    this.progress(runId, 'running', 'discover', 0, settings.github.discovery.enabled ? 2 : 1, '探索精选订阅源')
    const curatedDiscover = await this.services.subscriptions.discoverDirectorySources(this.signal(runId))
    this.patchStats(runId, { curatedDiscover })
    this.progress(runId, 'running', 'discover', 1, settings.github.discovery.enabled ? 2 : 1, '精选订阅源探索完成', curatedDiscover)
    if (settings.github.discovery.enabled) {
      await this.pausePoint(runId)
      this.progress(runId, 'running', 'discover', 0, 1, '搜索 GitHub 免费订阅')
      const discover = await this.services.subscriptions.discoverGithubSources({}, this.signal(runId))
      this.patchStats(runId, { discover })
      this.progress(runId, 'running', 'discover', 1, 1, 'GitHub 订阅搜索完成', discover)
    }
    this.ensureNotCancelled(runId)
    await this.pausePoint(runId)
    this.progress(runId, 'running', 'fetch', 0, 1, '刷新全部订阅')
    const result = await this.services.subscriptions.refreshAll(this.signal(runId))
    this.patchStats(runId, { fetch: result })
    this.progress(runId, 'running', 'fetch', 1, 1, '订阅刷新完成', result)
  }

  private async runAlive(runId: string, params: Record<string, unknown>): Promise<ProbeCandidate[]> {
    const requestedConcurrency = Number(params.concurrency ?? 100)
    const timeoutMs = Number(params.timeoutMs ?? 8000)
    const nodeIds = this.stringSetParam(params.nodeIds)
    const poolIds = this.stringSetParam(params.poolIds)
    const hasTargetFilter = nodeIds.size > 0 || poolIds.size > 0
    const candidates = this.getCandidatesForParams(params, false)
      .filter((candidate) => {
        if (!hasTargetFilter) return true
        if (candidate.origin === 'current') return nodeIds.has(candidate.node.id)
        return Boolean(candidate.poolId && poolIds.has(candidate.poolId))
      })
    const concurrency = hasTargetFilter
      ? Math.max(1, Math.min(requestedConcurrency, candidates.length || 1, 4))
      : requestedConcurrency
    let done = 0
    let alive = 0
    const aliveCandidates: ProbeCandidate[] = []
    const handleResult = async (
      candidate: ProbeCandidate,
      result: Awaited<ReturnType<ProbeEngine['testAlive']>>
    ) => {
      const node = candidate.node
      if (result.alive) alive += 1
      if (!result.alive) {
        this.removeDeadCandidate(candidate)
      } else {
        const geo = await this.resolveNodeCountry(node, result.exitIp, this.signal(runId))
        const updated = this.updateCandidateProbe(candidate, {
          alive: true,
          latencyMs: result.latencyMs,
          exitIp: result.exitIp,
          countryCode: geo.countryCode,
          countryName: geo.countryName,
          lastTestedAt: nowIso()
        })
        if (updated) aliveCandidates.push({ ...candidate, node: updated })
      }
      this.finishProgressNode(runId, candidate, 'alive', result.alive ? 'success' : 'failed', {
        alive: result.alive,
        latencyMs: result.latencyMs,
        detail: result.detail
      })
    }
    this.progress(runId, 'running', 'alive', 0, candidates.length, '测活开始')
    if (!hasTargetFilter && this.services.probe.testAliveMany) {
      const byId = new Map(candidates.map((candidate) => [candidate.node.id, candidate]))
      await this.services.probe.testAliveMany(
        candidates.map((candidate) => candidate.node),
        timeoutMs,
        concurrency,
        this.signal(runId),
        async (node, result) => {
          this.ensureNotCancelled(runId)
          await this.pausePoint(runId)
          const candidate = byId.get(node.id)
          if (!candidate) return
          await handleResult(candidate, result)
          done += 1
          this.progress(runId, 'running', 'alive', done, candidates.length, '测活中', { alive })
        },
        async (node, active) => {
          const candidate = byId.get(node.id)
          if (!candidate) return
          if (active) {
            this.startProgressNode(runId, candidate, 'alive')
            this.progress(runId, 'running', 'alive', done, candidates.length, '测活中', { alive })
          } else {
            this.clearActiveProgressNode(runId, candidate.node.id)
          }
        }
      )
    } else {
      await runLimited(candidates, concurrency, async (candidate) => {
      this.ensureNotCancelled(runId)
      await this.pausePoint(runId)
      this.startProgressNode(runId, candidate, 'alive')
      this.progress(runId, 'running', 'alive', done, candidates.length, '测活中', { alive })
      try {
        const node = candidate.node
        const result = await this.services.probe.testAlive(node, timeoutMs, this.signal(runId))
        if (result.alive) alive += 1
        if (!result.alive) {
          this.removeDeadCandidate(candidate)
        } else {
          const geo = await this.resolveNodeCountry(node, result.exitIp, this.signal(runId))
          const updated = this.updateCandidateProbe(candidate, {
            alive: true,
            latencyMs: result.latencyMs,
            exitIp: result.exitIp,
            countryCode: geo.countryCode,
            countryName: geo.countryName,
            lastTestedAt: nowIso()
          })
          if (updated) aliveCandidates.push({ ...candidate, node: updated })
        }
        this.finishProgressNode(runId, candidate, 'alive', result.alive ? 'success' : 'failed', {
          alive: result.alive,
          latencyMs: result.latencyMs,
          detail: result.detail
        })
      } catch (error) {
        if (this.isCancelled(runId, error)) throw new TaskCancelledError()
        this.removeDeadCandidate(candidate)
        this.finishProgressNode(runId, candidate, 'alive', 'failed', {
          alive: false,
          latencyMs: null,
          detail: error instanceof Error ? error.message : String(error)
        })
      } finally {
        done += 1
        this.progress(runId, 'running', 'alive', done, candidates.length, '测活中', { alive })
      }
      }, () => this.isCancelled(runId))
    }
    this.renumberCandidates(aliveCandidates)
    this.patchStats(runId, { alive })
    return aliveCandidates
  }

  private async runSpeed(
    runId: string,
    params: Record<string, unknown>,
    candidates?: ProbeCandidate[]
  ): Promise<ProbeCandidate[]> {
    const concurrency = Number(params.concurrency ?? 8)
    const timeoutMs = Number(params.timeoutMs ?? 8000)
    const minMBps = Number(params.minMBps ?? 3)
    const targetCount = Number(params.targetCount ?? 50)
    const testUrl = String(params.testUrl ?? 'https://speed.cloudflare.com/__down?bytes=1048576')
    const nodeIds = this.stringSetParam(params.nodeIds)
    const poolIds = this.stringSetParam(params.poolIds)
    const hasTargetFilter = nodeIds.size > 0 || poolIds.size > 0
    const nodes = (candidates ?? this.getCandidatesForParams(params, !hasTargetFilter))
      .filter((candidate) => {
        if (!hasTargetFilter && !candidate.node.alive) return false
        if (!hasTargetFilter) return true
        if (candidate.origin === 'current') return nodeIds.has(candidate.node.id)
        return Boolean(candidate.poolId && poolIds.has(candidate.poolId))
      })
      .sort((a, b) => this.speedCandidateScore(b) - this.speedCandidateScore(a))
    if (!nodes.length) {
      throw new Error('没有可测速的存活节点，请先运行测活并确认至少一个节点存活')
    }
    if (!this.services.probe.supportsProxyTests) {
      throw new Error('测速需要配置 mihomo。请在 .env 设置 MIHOMO_BIN 指向 mihomo.exe 或服务器上的 mihomo 可执行文件')
    }
    const minBps = minMBps * 1024 * 1024
    let done = 0
    let qualified = 0
    const handleSpeedResult = async (
      candidate: ProbeCandidate,
      result: Awaited<ReturnType<ProbeEngine['testSpeed']>>
    ) => {
      const ok = result.bps >= minBps
      if (ok) qualified += 1
      this.updateCandidateProbe(candidate, {
        speedBps: result.bps,
        speedQualified: ok,
        security: result.security,
        lastTestedAt: nowIso()
      })
      this.finishProgressNode(runId, candidate, 'speed', ok ? 'success' : 'failed', {
        speedMBps: toMBps(result.bps),
        detail: result.detail
      })
    }
    this.progress(runId, 'running', 'speed', 0, nodes.length, '测速开始', { qualified })
    if (!hasTargetFilter && this.services.probe.testSpeedMany) {
      const byId = new Map(nodes.map((candidate) => [candidate.node.id, candidate]))
      await this.services.probe.testSpeedMany(
        nodes.map((candidate) => candidate.node),
        testUrl,
        timeoutMs,
        concurrency,
        this.signal(runId),
        async (node, result) => {
          this.ensureNotCancelled(runId)
          await this.pausePoint(runId)
          const candidate = byId.get(node.id)
          if (!candidate) return
          await handleSpeedResult(candidate, result)
          done += 1
          this.progress(runId, 'running', 'speed', done, nodes.length, '测速中', { qualified })
        },
        async (node, active) => {
          const candidate = byId.get(node.id)
          if (!candidate) return
          if (active) {
            this.startProgressNode(runId, candidate, 'speed')
            this.progress(runId, 'running', 'speed', done, nodes.length, '测速中', { qualified })
          } else {
            this.clearActiveProgressNode(runId, candidate.node.id)
          }
        },
        () => this.isCancelled(runId) || qualified >= targetCount
      )
    } else {
    await runLimited(nodes, concurrency, async (candidate) => {
      this.ensureNotCancelled(runId)
      await this.pausePoint(runId)
      if (qualified >= targetCount) return
      this.startProgressNode(runId, candidate, 'speed')
      this.progress(runId, 'running', 'speed', done, nodes.length, '测速中', { qualified })
      try {
        const node = candidate.node
        const result = await this.services.probe.testSpeed(node, testUrl, timeoutMs, this.signal(runId))
        await handleSpeedResult(candidate, result)
      } catch (error) {
        if (this.isCancelled(runId, error)) throw new TaskCancelledError()
        this.updateCandidateProbe(candidate, {
          speedBps: 0,
          speedQualified: false,
          lastTestedAt: nowIso()
        })
        this.finishProgressNode(runId, candidate, 'speed', 'failed', {
          speedMBps: 0,
          detail: error instanceof Error ? error.message : String(error)
        })
      } finally {
        done += 1
        this.progress(runId, 'running', 'speed', done, nodes.length, '测速中', { qualified })
      }
    }, () => this.isCancelled(runId) || qualified >= targetCount)
    }
    this.renumberCandidates(nodes)
    this.patchStats(runId, { speedQualified: qualified, speedTested: done })
    return nodes
  }

  private async runUnlock(
    runId: string,
    params: Record<string, unknown>,
    candidates?: ProbeCandidate[]
  ): Promise<void> {
    const concurrency = Number(params.concurrency ?? 40)
    const timeoutMs = Number(params.timeoutMs ?? 10000)
    const platforms = (params.platforms as UnlockPlatform[] | undefined) ?? ['openai', 'youtube', 'netflix', 'disney']
    const nodes = (candidates ?? this.getCandidatesForParams(params, true)).filter(
      (candidate) => candidate.node.alive
    )
    if (!nodes.length) {
      throw new Error('没有可检测解锁的存活节点，请先运行测活并确认至少一个节点存活')
    }
    if (!this.services.probe.supportsProxyTests) {
      throw new Error('解锁检测需要配置 mihomo。请在 .env 设置 MIHOMO_BIN 指向 mihomo.exe 或服务器上的 mihomo 可执行文件')
    }
    const total = nodes.length * platforms.length
    let done = 0
    const unlocked: Record<string, number> = Object.fromEntries(platforms.map((platform) => [platform, 0]))
    this.progress(runId, 'running', 'unlock', 0, total, '解锁检测开始', unlocked)
    await runLimited(nodes, concurrency, async (candidate) => {
      for (const platform of platforms) {
        this.ensureNotCancelled(runId)
        await this.pausePoint(runId)
        const current = this.getCandidateNode(candidate)
        if (!current) {
          done += 1
          this.progress(runId, 'running', 'unlock', done, total, '解锁检测中', unlocked)
          continue
        }
        this.startProgressNode(runId, candidate, `unlock:${platform}`)
        this.progress(runId, 'running', 'unlock', done, total, '解锁检测中', unlocked)
        const unlock: UnlockMap = { ...current.unlock }
        let detail: string | undefined
        let region: string | null | undefined
        let available = false
        try {
          const result = await this.services.probe.testUnlock(current, platform, timeoutMs, this.signal(runId))
          unlock[platform] = result
          available = result.available
          detail = result.detail
          region = result.region
          if (result.available) unlocked[platform] = (unlocked[platform] ?? 0) + 1
        } catch (error) {
          if (this.isCancelled(runId, error)) throw new TaskCancelledError()
          detail = error instanceof Error ? error.message : String(error)
          unlock[platform] = {
            available: false,
            detail,
            checkedAt: nowIso()
          }
        } finally {
          this.updateCandidateProbe(candidate, {
            unlock,
            lastTestedAt: nowIso()
          })
          this.finishProgressNode(runId, candidate, `unlock:${platform}`, available ? 'success' : 'failed', {
            platform,
            unlockAvailable: available,
            region,
            detail
          })
          done += 1
          this.progress(runId, 'running', 'unlock', done, total, '解锁检测中', unlocked)
        }
      }
    }, () => this.isCancelled(runId))
    this.patchStats(runId, { unlock: unlocked })
  }

  private renumberCandidates(candidates: ProbeCandidate[]): void {
    const groups = new Map<string, ProbeCandidate[]>()
    for (const candidate of candidates.filter((item) => item.node.alive)) {
      const countryName = candidate.node.countryName || candidate.node.countryCode || '未知'
      const group = groups.get(countryName)
      if (group) {
        group.push(candidate)
      } else {
        groups.set(countryName, [candidate])
      }
    }
    for (const [countryName, group] of groups.entries()) {
      const sorted = group.sort((a, b) => (a.node.latencyMs ?? 999999) - (b.node.latencyMs ?? 999999))
      sorted.forEach((candidate, index) => {
        const node = candidate.node
        const base = `${countryName}-${String(index + 1).padStart(2, '0')}`
        const speed = node.speedBps && node.speedBps > 0 ? `-${toMBps(node.speedBps)}MB/s` : ''
        this.updateCandidateProbe(candidate, {
          displayName: `${base}${speed}`
        })
      })
    }
  }

  private getCandidateNode(candidate: ProbeCandidate): NodeEntity | null {
    const current =
      candidate.origin === 'pool' && candidate.poolId
        ? this.services.store.getReusableNode(candidate.poolId)
        : this.services.store.getNode(candidate.node.id)
    if (current) candidate.node = current
    return current
  }

  private async resolveNodeCountry(
    node: NodeEntity,
    exitIp: string | null,
    signal?: AbortSignal
  ): Promise<{ countryCode: string | null; countryName: string | null }> {
    const settings = this.services.store.getSettings()
    const geo = await this.services.geoip.lookup(exitIp, settings.geoip, signal)
    if (geo.countryCode) return geo
    if (!exitIp && net.isIP(node.server)) {
      const serverGeo = await this.services.geoip.lookup(node.server, settings.geoip, signal)
      if (serverGeo.countryCode) return serverGeo
    }
    return inferCountryFromText(`${node.displayName} ${node.originalName}`)
  }

  private updateCandidateProbe(candidate: ProbeCandidate, patch: NodeProbePatch): NodeEntity | null {
    const updated =
      candidate.origin === 'pool' && candidate.poolId
        ? this.services.store.updateReusableNodeProbe(candidate.poolId, { node: patch })
        : this.services.store.updateNodeProbe(candidate.node.id, patch)
    if (updated) candidate.node = updated
    return updated
  }

  private removeDeadCandidate(candidate: ProbeCandidate): void {
    candidate.node = {
      ...candidate.node,
      alive: false,
      latencyMs: null,
      speedBps: null,
      speedMBps: null,
      speedQualified: false,
      lastTestedAt: nowIso()
    }
    if (candidate.origin === 'pool' && candidate.poolId) {
      this.services.store.updateReusableNodeProbe(candidate.poolId, {
        node: {
          alive: false,
          latencyMs: null,
          speedBps: null,
          speedQualified: false,
          lastTestedAt: nowIso()
        }
      })
      return
    }
    this.services.store.deleteNode(candidate.node.id)
  }

  private getCandidatesForParams(params: Record<string, unknown>, aliveOnly: boolean): ProbeCandidate[] {
    const scope = String(params.scope ?? (aliveOnly ? 'alive' : 'all'))
    const includeAllPool = Boolean(params.includeAllPool) || scope === 'pool'
    const candidates = this.services.store.getProbeCandidates({ aliveOnly, includeAllPool })
    if (scope === 'pool') return candidates.filter((candidate) => candidate.origin === 'pool')
    if (scope === 'current') return candidates.filter((candidate) => candidate.origin === 'current')
    return candidates
  }

  private speedCandidateScore(candidate: ProbeCandidate): number {
    const node = candidate.node
    const unlockCount = Object.values(node.unlock).filter((item) => item?.available).length
    const risk = node.security?.risk ?? 'unknown'
    return (
      (candidate.origin === 'pool' ? 1200 : 0) +
      (node.speedQualified ? 900 : 0) +
      (node.speedMBps ?? 0) * 120 +
      unlockCount * 160 +
      Math.max(0, 1000 - (node.latencyMs ?? 1000)) +
      node.sourceIds.length * 8 -
      (risk === 'suspicious' ? 100000 : 0)
    )
  }

  private generateArtifactsAfterPartialRun(type: RunType): void {
    if (!['full', 'alive', 'speed', 'unlock', 'country_backup'].includes(type)) return
    try {
      this.services.artifacts.generateStandardArtifacts()
    } catch {
      // The original task error is more useful; artifact generation will be retried on the next successful run.
    }
  }

  private stringSetParam(value: unknown): Set<string> {
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))
  }

  private progress(
    runId: string,
    status: RunStatus,
    stage: RunProgress['stage'],
    current: number,
    total: number,
    message: string,
    stats?: Record<string, unknown>
  ): void {
    if (status === 'running' && this.cancelled.has(runId)) return
    const effectiveStatus = status === 'running' && this.paused.has(runId) ? 'paused' : status
    const progress = {
      runId,
      status: effectiveStatus,
      stage,
      current,
      total,
      message: effectiveStatus === 'paused' ? '任务已暂停' : message,
      stats,
      ...this.progressDetailSnapshot(runId)
    }
    if (!this.shouldFlushProgress(progress)) return
    this.services.store.updateRun(runId, {
      status: effectiveStatus,
      progress
    })
    this.emit(runId)
  }

  private async pausePoint(runId: string): Promise<void> {
    this.ensureNotCancelled(runId)
    if (!this.paused.has(runId)) return
    await this.waitWhilePaused(runId)
    this.ensureNotCancelled(runId)
  }

  private async waitWhilePaused(runId: string): Promise<void> {
    while (this.paused.has(runId) && !this.cancelled.has(runId)) {
      await new Promise<void>((resolve) => {
        const waiters = this.pauseWaiters.get(runId) ?? []
        waiters.push(resolve)
        this.pauseWaiters.set(runId, waiters)
      })
    }
  }

  private resumePausedWaiters(runId: string): void {
    const waiters = this.pauseWaiters.get(runId) ?? []
    this.pauseWaiters.delete(runId)
    for (const resolve of waiters) resolve()
  }

  private startProgressNode(runId: string, candidate: ProbeCandidate, action: string): void {
    const details = this.ensureProgressDetails(runId)
    details.active.set(candidate.node.id, {
      ...this.progressNodeBase(candidate, action),
      status: 'running'
    })
  }

  private clearActiveProgressNode(runId: string, nodeId: string): void {
    this.progressDetails.get(runId)?.active.delete(nodeId)
  }

  private finishProgressNode(
    runId: string,
    candidate: ProbeCandidate,
    action: string,
    status: RunProgressNode['status'],
    patch: Partial<RunProgressNode> = {}
  ): void {
    const details = this.ensureProgressDetails(runId)
    details.active.delete(candidate.node.id)
    details.recent.unshift({
      ...this.progressNodeBase(candidate, action),
      ...patch,
      status,
      updatedAt: nowIso()
    })
    details.recent = details.recent.slice(0, 30)
  }

  private progressNodeBase(candidate: ProbeCandidate, action: string): RunProgressNode {
    const node = candidate.node
    return {
      id: node.id,
      name: node.displayName || node.originalName || node.id,
      protocol: node.protocol,
      server: node.server,
      port: node.port,
      origin: candidate.origin,
      action,
      status: 'running',
      updatedAt: nowIso()
    }
  }

  private ensureProgressDetails(runId: string): { active: Map<string, RunProgressNode>; recent: RunProgressNode[] } {
    const existing = this.progressDetails.get(runId)
    if (existing) return existing
    const created = { active: new Map<string, RunProgressNode>(), recent: [] }
    this.progressDetails.set(runId, created)
    return created
  }

  private progressDetailSnapshot(runId: string): Pick<RunProgress, 'active' | 'recent'> {
    const details = this.progressDetails.get(runId)
    if (!details) return {}
    return {
      active: [...details.active.values()].slice(0, 40),
      recent: details.recent.slice(0, 30)
    }
  }

  private shouldFlushProgress(progress: RunProgress): boolean {
    const now = Date.now()
    const key = `${progress.status}:${progress.stage ?? ''}:${progress.message ?? ''}:${progress.total ?? ''}`
    const last = this.progressFlushes.get(progress.runId)
    const current = progress.current ?? 0
    const total = progress.total ?? 0
    const important =
      progress.status !== 'running' ||
      current === 0 ||
      (total > 0 && current >= total)
    if (!last || last.key !== key || important || now - last.at >= this.progressThrottleMs) {
      this.progressFlushes.set(progress.runId, { at: now, key })
      return true
    }
    return false
  }

  private patchStats(runId: string, stats: Record<string, unknown>): void {
    const run = this.services.store.getRun(runId)
    if (!run) return
    this.services.store.updateRun(runId, {
      stats: {
        ...run.stats,
        ...stats
      }
    })
  }

  private ensureNotCancelled(runId: string): void {
    if (this.isCancelled(runId)) throw new TaskCancelledError()
  }

  private isCancelled(runId: string, error?: unknown): boolean {
    return (
      this.cancelled.has(runId) ||
      this.signal(runId)?.aborted === true ||
      error instanceof TaskCancelledError ||
      (error instanceof Error && error.name === 'AbortError' && this.cancelled.has(runId))
    )
  }

  private signal(runId: string): AbortSignal | undefined {
    return this.abortControllers.get(runId)?.signal
  }

  private emit(runId: string): void {
    const run: TestRunEntity | null = this.services.store.getRun(runId)
    if (run?.progress) {
      this.events.emit(`run:${runId}`, run.progress)
    }
  }
}
