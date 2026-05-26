import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import YAML from 'yaml'
import type { AppConfig } from './config'
import { toClashProxy } from './codec'
import type { AppSettings, NodeEntity, SecurityCheck, UnlockPlatform, UnlockResult } from './types'
import { abortError, newId, nowIso, runLimited, throwIfAborted, withTimeoutSignal } from './utils'

export type AliveProbe = {
  alive: boolean
  latencyMs: number | null
  exitIp: string | null
  detail?: string
}

export type SpeedProbe = {
  bps: number
  detail?: string
  security?: SecurityCheck
}

export interface ProbeEngine {
  supportsProxyTests: boolean
  testAlive(node: NodeEntity, timeoutMs: number, signal?: AbortSignal): Promise<AliveProbe>
  testAliveMany?(
    nodes: NodeEntity[],
    timeoutMs: number,
    concurrency: number,
    signal: AbortSignal | undefined,
    onResult: (node: NodeEntity, result: AliveProbe) => Promise<void> | void,
    onActive?: (node: NodeEntity, active: boolean) => Promise<void> | void
  ): Promise<void>
  testSpeed(node: NodeEntity, testUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<SpeedProbe>
  testSpeedMany?(
    nodes: NodeEntity[],
    testUrl: string,
    timeoutMs: number,
    concurrency: number,
    signal: AbortSignal | undefined,
    onResult: (node: NodeEntity, result: SpeedProbe) => Promise<void> | void,
    onActive?: (node: NodeEntity, active: boolean) => Promise<void> | void,
    shouldStop?: () => boolean
  ): Promise<void>
  testUnlock(node: NodeEntity, platform: UnlockPlatform, timeoutMs: number, signal?: AbortSignal): Promise<UnlockResult>
}

export const createProbeEngine = (config: AppConfig, getSettings: () => AppSettings): ProbeEngine => {
  if (config.mihomoBin && fs.existsSync(config.mihomoBin)) return new MihomoProbeEngine(config, getSettings)
  return new TcpFallbackProbeEngine()
}

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const isAbortError = (error: unknown): boolean => {
  return error instanceof Error && error.name === 'AbortError'
}

const readSampleBytes = async (res: Response, maxBytes: number): Promise<number> => {
  if (!res.body) {
    const buffer = await res.arrayBuffer()
    return Math.min(buffer.byteLength, maxBytes)
  }
  const reader = res.body.getReader()
  let received = 0
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += Math.min(value.byteLength, maxBytes - received)
    }
    if (received >= maxBytes) await reader.cancel().catch(() => undefined)
    return received
  } finally {
    reader.releaseLock()
  }
}

const tlsRiskPattern = /certificate|cert_|self.?signed|unable to verify|tls|ssl|x509|handshake|ERR_CERT/i

const securityFromError = (error: unknown): SecurityCheck | undefined => {
  const detail = errorMessage(error)
  if (!tlsRiskPattern.test(detail)) return undefined
  return {
    risk: 'suspicious',
    detail: `HTTPS certificate validation failed: ${detail}`,
    checkedAt: nowIso()
  }
}

const checkHttpsSecurityViaProxy = async (
  mixedPort: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SecurityCheck> => {
  const endpoints = [
    {
      url: 'https://www.gstatic.com/generate_204',
      ok: (status: number, text: string) => [204, 200].includes(status) && text.length < 512
    },
    {
      url: 'https://www.cloudflare.com/cdn-cgi/trace',
      ok: (status: number, text: string) => status >= 200 && status < 300 && /^ip=/m.test(text)
    }
  ]
  let lastDetail = ''
  let sawCertificateError = false
  for (const endpoint of endpoints) {
    throwIfAborted(signal)
    const agent = new ProxyAgent(`http://127.0.0.1:${mixedPort}`)
    try {
      const res = await undiciFetch(endpoint.url, {
        dispatcher: agent,
        signal: withTimeoutSignal(Math.min(timeoutMs, 5000), signal)
      })
      const text = res.status === 204 ? '' : await res.text()
      if (endpoint.ok(res.status, text)) {
        return {
          risk: 'safe',
          detail: `HTTPS probe ok: ${endpoint.url} HTTP ${res.status}`,
          checkedAt: nowIso()
        }
      }
      lastDetail = `unexpected HTTPS probe response from ${endpoint.url}: HTTP ${res.status}`
    } catch (error) {
      const detail = errorMessage(error)
      sawCertificateError ||= tlsRiskPattern.test(detail)
      lastDetail = detail
    } finally {
      await agent.close().catch(() => undefined)
    }
  }
  return {
    risk: sawCertificateError ? 'suspicious' : 'unknown',
    detail: sawCertificateError
      ? `HTTPS certificate validation failed: ${lastDetail}`
      : `HTTPS probe inconclusive: ${lastDetail}`,
    checkedAt: nowIso()
  }
}

class TcpFallbackProbeEngine implements ProbeEngine {
  supportsProxyTests = false

  async testAlive(node: NodeEntity, timeoutMs: number, signal?: AbortSignal): Promise<AliveProbe> {
    throwIfAborted(signal)
    const started = Date.now()
    const alive = await new Promise<boolean>((resolve, reject) => {
      const socket = net.createConnection({ host: node.server, port: node.port })
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      const abort = () => {
        cleanup()
        socket.destroy()
        reject(abortError())
      }
      const timer = setTimeout(() => {
        cleanup()
        socket.destroy()
        resolve(false)
      }, timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      socket.once('connect', () => {
        cleanup()
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        cleanup()
        resolve(false)
      })
    })
    return {
      alive,
      latencyMs: alive ? Date.now() - started : null,
      exitIp: null,
      detail: 'mihomo not configured; used TCP reachability fallback'
    }
  }

  async testSpeed(_node: NodeEntity, _testUrl: string, _timeoutMs: number, signal?: AbortSignal): Promise<SpeedProbe> {
    throwIfAborted(signal)
    return {
      bps: 0,
      detail: 'mihomo not configured; speed test skipped'
    }
  }

  async testUnlock(_node: NodeEntity, platform: UnlockPlatform, _timeoutMs: number, signal?: AbortSignal): Promise<UnlockResult> {
    throwIfAborted(signal)
    return {
      available: false,
      detail: `mihomo not configured; ${platform} unlock test skipped`,
      checkedAt: nowIso()
    }
  }
}

class MihomoProbeEngine implements ProbeEngine {
  supportsProxyTests = true

  private portCursor = 0

  constructor(
    private readonly config: AppConfig,
    private readonly getSettings: () => AppSettings
  ) {
    fs.mkdirSync(config.mihomoDir, { recursive: true })
  }

  async testAlive(node: NodeEntity, timeoutMs: number, signal?: AbortSignal): Promise<AliveProbe> {
    return this.withRuntime(node, timeoutMs, signal, async (runtime) => {
      const started = Date.now()
      const delay = await runtime.delay(timeoutMs, signal)
      const exitIp = await runtime.fetchExitIp(timeoutMs, signal)
      return {
        alive: delay >= 0,
        latencyMs: delay >= 0 ? delay : Date.now() - started,
        exitIp,
        detail: 'mihomo'
      }
    })
  }

  async testAliveMany(
    nodes: NodeEntity[],
    timeoutMs: number,
    concurrency: number,
    signal: AbortSignal | undefined,
    onResult: (node: NodeEntity, result: AliveProbe) => Promise<void> | void,
    onActive?: (node: NodeEntity, active: boolean) => Promise<void> | void
  ): Promise<void> {
    if (!nodes.length) return
    const desiredWorkers = nodes.length >= 3000 ? 6 : nodes.length >= 1000 ? 4 : nodes.length >= 300 ? 2 : 1
    const batchWorkers = Math.max(1, Math.min(6, desiredWorkers, nodes.length, Math.max(1, concurrency)))
    const chunkSize = Math.max(120, Math.min(700, Math.ceil(nodes.length / batchWorkers)))
    const chunks = this.chunk(nodes, chunkSize)
    const perBatchConcurrency = Math.max(1, Math.ceil(Math.max(1, concurrency) / Math.min(batchWorkers, chunks.length)))
    await runLimited(chunks, Math.min(batchWorkers, chunks.length), async (chunk) => {
      await this.testAliveChunk(chunk, timeoutMs, perBatchConcurrency, signal, onResult, onActive)
    }, () => Boolean(signal?.aborted))
  }

  private async testAliveChunk(
    nodes: NodeEntity[],
    timeoutMs: number,
    concurrency: number,
    signal: AbortSignal | undefined,
    onResult: (node: NodeEntity, result: AliveProbe) => Promise<void> | void,
    onActive?: (node: NodeEntity, active: boolean) => Promise<void> | void
  ): Promise<void> {
    if (!nodes.length) return
    const ports = this.nextPorts()
    const runtime = new MihomoBatchRuntime(this.config, nodes, ports.mixedPort, ports.controllerPort)
    const startupTimeout = Math.max(15000, Math.min(45000, timeoutMs + nodes.length * 12))
    try {
      throwIfAborted(signal)
      try {
        await runtime.start(startupTimeout, signal)
      } catch (error) {
        if (isAbortError(error)) throw error
        const startupError = errorMessage(error)
        if (nodes.length > 30) {
          const mid = Math.ceil(nodes.length / 2)
          await runLimited(
            [nodes.slice(0, mid), nodes.slice(mid)],
            2,
            async (chunk) => this.testAliveChunk(chunk, timeoutMs, concurrency, signal, onResult, onActive),
            () => Boolean(signal?.aborted)
          )
          return
        }
        const fallbackConcurrency = Math.max(1, Math.min(concurrency, nodes.length, 16))
        await runLimited(nodes, fallbackConcurrency, async (node) => {
          throwIfAborted(signal)
          await onActive?.(node, true)
          try {
            const result = await this.testAlive(node, timeoutMs, signal)
            await onResult(node, {
              ...result,
              detail: result.detail ? `${result.detail}; batch fallback: ${startupError}` : `batch fallback: ${startupError}`
            })
          } catch (singleError) {
            if (isAbortError(singleError)) throw singleError
            await onResult(node, {
              alive: false,
              latencyMs: null,
              exitIp: null,
              detail: `batch startup failed: ${startupError}; single probe failed: ${errorMessage(singleError)}`
            })
          } finally {
            await onActive?.(node, false)
          }
        }, () => Boolean(signal?.aborted))
        return
      }
      await runLimited(nodes, concurrency, async (node) => {
        throwIfAborted(signal)
        const started = Date.now()
        await onActive?.(node, true)
        try {
          const delay = await runtime.delay(node.id, timeoutMs, signal)
          await onResult(node, {
            alive: delay >= 0,
            latencyMs: delay >= 0 ? delay : Date.now() - started,
            exitIp: null,
            detail: 'mihomo batch'
          })
        } catch (error) {
          if (isAbortError(error)) throw error
          await onResult(node, {
            alive: false,
            latencyMs: null,
            exitIp: null,
            detail: error instanceof Error ? error.message : String(error)
          })
        } finally {
          await onActive?.(node, false)
        }
      }, () => Boolean(signal?.aborted))
    } finally {
      runtime.stop()
    }
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size))
    }
    return chunks
  }

  private distribute<T>(items: T[], workers: number): T[][] {
    const chunks = Array.from({ length: workers }, () => [] as T[])
    items.forEach((item, index) => chunks[index % workers].push(item))
    return chunks.filter((chunk) => chunk.length)
  }

  async testSpeed(node: NodeEntity, testUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<SpeedProbe> {
    return this.withRuntime(node, timeoutMs, signal, async (runtime) => {
      const started = Date.now()
      const bytes = await runtime.downloadBytes(testUrl, timeoutMs, signal)
      const security = await runtime.checkHttpsSecurity(timeoutMs, signal)
      const seconds = Math.max(0.001, (Date.now() - started) / 1000)
      return {
        bps: Math.round(bytes / seconds),
        detail: 'mihomo',
        security
      }
    })
  }

  async testSpeedMany(
    nodes: NodeEntity[],
    testUrl: string,
    timeoutMs: number,
    concurrency: number,
    signal: AbortSignal | undefined,
    onResult: (node: NodeEntity, result: SpeedProbe) => Promise<void> | void,
    onActive?: (node: NodeEntity, active: boolean) => Promise<void> | void,
    shouldStop?: () => boolean
  ): Promise<void> {
    if (!nodes.length) return
    const workerCount = Math.max(1, Math.min(16, Math.max(1, concurrency), nodes.length))
    const chunks = this.distribute(nodes, workerCount)
    await runLimited(chunks, chunks.length, async (chunk) => {
      await this.testSpeedChunk(chunk, testUrl, timeoutMs, signal, onResult, onActive, shouldStop)
    }, () => Boolean(signal?.aborted) || Boolean(shouldStop?.()))
  }

  private async testSpeedChunk(
    nodes: NodeEntity[],
    testUrl: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onResult: (node: NodeEntity, result: SpeedProbe) => Promise<void> | void,
    onActive?: (node: NodeEntity, active: boolean) => Promise<void> | void,
    shouldStop?: () => boolean
  ): Promise<void> {
    if (!nodes.length) return
    const ports = this.nextPorts()
    const runtime = new MihomoBatchRuntime(this.config, nodes, ports.mixedPort, ports.controllerPort)
    const startupTimeout = Math.max(15000, Math.min(45000, timeoutMs + nodes.length * 12))
    try {
      try {
        await runtime.start(startupTimeout, signal)
      } catch (error) {
        if (isAbortError(error)) throw error
        await runLimited(nodes, Math.min(4, nodes.length), async (node) => {
          if (shouldStop?.()) return
          throwIfAborted(signal)
          await onActive?.(node, true)
          try {
            const result = await this.testSpeed(node, testUrl, timeoutMs, signal)
            await onResult(node, result)
          } catch (singleError) {
            if (isAbortError(singleError)) throw singleError
          await onResult(node, {
            bps: 0,
            detail: `batch speed startup failed: ${errorMessage(error)}; single speed failed: ${errorMessage(singleError)}`,
            security: securityFromError(singleError)
          })
          } finally {
            await onActive?.(node, false)
          }
        }, () => Boolean(signal?.aborted) || Boolean(shouldStop?.()))
        return
      }
      for (const node of nodes) {
        if (shouldStop?.()) return
        throwIfAborted(signal)
        await onActive?.(node, true)
        try {
          await runtime.select(node.id, timeoutMs, signal)
          const started = Date.now()
          const bytes = await runtime.downloadBytes(testUrl, timeoutMs, signal)
          const security = await runtime.checkHttpsSecurity(timeoutMs, signal)
          const seconds = Math.max(0.001, (Date.now() - started) / 1000)
          await onResult(node, {
            bps: Math.round(bytes / seconds),
            detail: 'mihomo batch speed',
            security
          })
        } catch (error) {
          if (isAbortError(error)) throw error
          await onResult(node, {
            bps: 0,
            detail: errorMessage(error),
            security: securityFromError(error)
          })
        } finally {
          await onActive?.(node, false)
        }
      }
    } finally {
      runtime.stop()
    }
  }

  async testUnlock(node: NodeEntity, platform: UnlockPlatform, timeoutMs: number, signal?: AbortSignal): Promise<UnlockResult> {
    return this.withRuntime(node, timeoutMs, signal, async (runtime) => {
      const checkedAt = nowIso()
      const settings = this.getSettings()
      const targetUrl = settings.unlockTest[platform]
      try {
        if (platform === 'openai') {
          const res = await runtime.fetchText(targetUrl, timeoutMs, signal)
          const region = /loc=([A-Z]{2})/.exec(res.text)?.[1]
          const unavailable = /unsupported|blocked|not available in your country|unable to load site|request blocked|sorry, you have been blocked|captcha/i.test(res.text)
          const looksLikeChatGptPage =
            /chatgpt|openai|auth0|__next/i.test(res.text) &&
            !/ERR_CONNECTION_CLOSED|this site can'?t be reached|无法访问此页面/i.test(res.text)
          return {
            available: res.status >= 200 && res.status < 400 && !unavailable && looksLikeChatGptPage,
            region,
            detail: `HTTP ${res.status} ${targetUrl}${region ? ` ${region}` : ''}${unavailable ? ' unavailable' : ''}${looksLikeChatGptPage ? '' : ' unexpected-page'}`,
            checkedAt
          }
        }
        if (platform === 'youtube') {
          const res = await runtime.fetchText(targetUrl, timeoutMs, signal)
          const blocked = /not available in your country|premium is not available/i.test(res.text)
          return {
            available: res.status >= 200 && res.status < 500 && !blocked,
            detail: `HTTP ${res.status} ${targetUrl}${blocked ? ' blocked/unavailable' : ''}`,
            checkedAt
          }
        }
        if (platform === 'netflix') {
          const res = await runtime.fetchText(targetUrl, timeoutMs, signal)
          const blocked = /not available|unavailable|blocked|proxy|vpn|unblocker|pardon the interruption/i.test(res.text)
          const limited = res.status === 404 || /watch free|netflix originals/i.test(res.text)
          return {
            available: res.status >= 200 && res.status < 500 && !blocked && !limited,
            detail: `HTTP ${res.status} ${targetUrl}${blocked ? ' blocked/unavailable' : limited ? ' limited/catalog-only' : ''}`,
            checkedAt
          }
        }
        const res = await runtime.fetchText(targetUrl, timeoutMs, signal)
        const blocked = /not available|unavailable|not available in your region|unsupported location|service unavailable/i.test(res.text)
        return {
          available: res.status >= 200 && res.status < 500 && !blocked,
          detail: `HTTP ${res.status} ${targetUrl}${blocked ? ' blocked/unavailable' : ''}`,
          checkedAt
        }
      } catch (error) {
        return {
          available: false,
          detail: error instanceof Error ? error.message : String(error),
          checkedAt
        }
      }
    })
  }

  private async withRuntime<T>(
    node: NodeEntity,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    fn: (runtime: MihomoRuntime) => Promise<T>
  ): Promise<T> {
    const ports = this.nextPorts()
    const runtime = new MihomoRuntime(this.config, node, ports.mixedPort, ports.controllerPort)
    try {
      throwIfAborted(signal)
      await runtime.start(timeoutMs, signal)
      throwIfAborted(signal)
      return await fn(runtime)
    } finally {
      runtime.stop()
    }
  }

  private nextPorts(): { mixedPort: number; controllerPort: number } {
    const offset = this.portCursor
    this.portCursor = (this.portCursor + 1) % 2000
    return {
      mixedPort: this.config.mihomoBasePort + offset * 2,
      controllerPort: this.config.mihomoBaseControllerPort + offset * 2
    }
  }
}

class MihomoRuntime {
  private proc: ChildProcessWithoutNullStreams | null = null
  private outputTail = ''
  private procExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private procError: Error | null = null
  private readonly name: string
  private readonly workDir: string
  private readonly configPath: string

  constructor(
    private readonly config: AppConfig,
    private readonly node: NodeEntity,
    private readonly mixedPort: number,
    private readonly controllerPort: number
  ) {
    this.name = `ProxyNest-${node.id}`
    this.workDir = path.join(config.mihomoDir, newId('probe'))
    this.configPath = path.join(this.workDir, 'config.yaml')
  }

  async start(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    fs.mkdirSync(this.workDir, { recursive: true })
    const proxy = toClashProxy(this.node)
    if (!proxy) throw new Error(`node ${this.node.id} cannot be converted to mihomo proxy`)
    proxy.name = this.name
    const config = {
      'mixed-port': this.mixedPort,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'silent',
      'external-controller': `127.0.0.1:${this.controllerPort}`,
      secret: this.config.mihomoApiSecret,
      proxies: [proxy],
      'proxy-groups': [
        {
          name: 'ProxyNest',
          type: 'select',
          proxies: [this.name]
        }
      ],
      rules: ['MATCH,ProxyNest']
    }
    fs.writeFileSync(this.configPath, YAML.stringify(config), 'utf8')
    this.proc = spawn(this.config.mihomoBin, ['-f', this.configPath, '-d', this.workDir], {
      env: this.directEnv(),
      windowsHide: true
    })
    this.proc.stdout.on('data', (chunk) => this.captureOutput(chunk))
    this.proc.stderr.on('data', (chunk) => this.captureOutput(chunk))
    this.proc.once('exit', (code, signal) => {
      this.procExit = { code, signal }
    })
    this.proc.once('error', (error) => {
      this.procError = error
    })
    await this.waitReady(timeoutMs, signal)
  }

  stop(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill()
    }
    try {
      fs.rmSync(this.workDir, { recursive: true, force: true })
    } catch {
      // Best effort cleanup only.
    }
  }

  async delay(timeoutMs: number, signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal)
    const url = `${this.controllerUrl()}/proxies/${encodeURIComponent(this.name)}/delay?timeout=${timeoutMs}&url=${encodeURIComponent('http://www.gstatic.com/generate_204')}`
    const res = await undiciFetch(url, { headers: this.headers(), signal: withTimeoutSignal(timeoutMs + 1000, signal) })
    if (!res.ok) return -1
    const json = (await res.json()) as { delay?: number }
    return typeof json.delay === 'number' ? json.delay : -1
  }

  async fetchExitIp(timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
    const endpoints: Array<{
      url: string
      parse: (text: string) => string | null
    }> = [
      {
        url: 'https://api.ipify.org?format=json',
        parse: (text) => {
          try {
            return (JSON.parse(text) as { ip?: string }).ip || null
          } catch {
            return null
          }
        }
      },
      {
        url: 'https://www.cloudflare.com/cdn-cgi/trace',
        parse: (text) => /^ip=(.+)$/m.exec(text)?.[1]?.trim() || null
      },
      {
        url: 'https://api64.ipify.org',
        parse: (text) => text.trim() || null
      }
    ]
    for (const endpoint of endpoints) {
      throwIfAborted(signal)
      try {
        const res = await this.fetchText(endpoint.url, timeoutMs, signal)
        const ip = endpoint.parse(res.text)
        if (ip) return ip
      } catch {
        // Try the next endpoint.
      }
    }
    return null
  }

  async downloadBytes(url: string, timeoutMs: number, signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal)
    const agent = new ProxyAgent(`http://127.0.0.1:${this.mixedPort}`)
    try {
      const res = await undiciFetch(url, {
        dispatcher: agent,
        headers: this.browserHeaders(),
        signal: withTimeoutSignal(timeoutMs, signal)
      })
      if (!res.ok) throw new Error(`speed test HTTP ${res.status}`)
      return await readSampleBytes(res, 2 * 1024 * 1024)
    } finally {
      await agent.close().catch(() => undefined)
    }
  }

  async fetchText(url: string, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; text: string }> {
    throwIfAborted(signal)
    const agent = new ProxyAgent(`http://127.0.0.1:${this.mixedPort}`)
    try {
      const res = await undiciFetch(url, {
        dispatcher: agent,
        headers: this.browserHeaders(),
        signal: withTimeoutSignal(timeoutMs, signal)
      })
      const text = await res.text()
      return { status: res.status, text }
    } finally {
      await agent.close().catch(() => undefined)
    }
  }

  async checkHttpsSecurity(timeoutMs: number, signal?: AbortSignal): Promise<SecurityCheck> {
    return checkHttpsSecurityViaProxy(this.mixedPort, timeoutMs, signal)
  }

  private async waitReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      this.throwProcessFailure('mihomo did not become ready', lastError)
      try {
        const res = await undiciFetch(`${this.controllerUrl()}/version`, {
          headers: this.headers(),
          signal: withTimeoutSignal(500, signal)
        })
        if (res.ok) return
      } catch (error) {
        lastError = error
      }
      await this.sleep(150, signal)
    }
    this.throwProcessFailure('mihomo did not become ready', lastError)
    throw new Error(`mihomo did not become ready: ${lastError instanceof Error ? lastError.message : 'timeout'}`)
  }

  private captureOutput(chunk: Buffer | string): void {
    this.outputTail = `${this.outputTail}${String(chunk)}`.slice(-4000)
  }

  private throwProcessFailure(prefix: string, lastError?: unknown): void {
    if (this.procError) {
      throw new Error(`${prefix}: ${this.procError.message}${this.outputDetail(lastError)}`)
    }
    if (this.procExit) {
      const exitText = this.procExit.signal
        ? `exited by signal ${this.procExit.signal}`
        : `exited with code ${this.procExit.code ?? 'unknown'}`
      throw new Error(`${prefix}: mihomo ${exitText}${this.outputDetail(lastError)}`)
    }
  }

  private outputDetail(lastError?: unknown): string {
    const parts: string[] = []
    if (lastError instanceof Error) parts.push(`last controller error: ${lastError.message}`)
    const tail = this.outputTail.trim().replace(/\s+/g, ' ')
    if (tail) parts.push(`mihomo output: ${tail}`)
    return parts.length ? `; ${parts.join('; ')}` : ''
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, ms)
      const abort = () => {
        cleanup()
        reject(abortError())
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private controllerUrl(): string {
    return `http://127.0.0.1:${this.controllerPort}`
  }

  private browserHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.mihomoApiSecret}`
    }
  }

  private directEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy'
    ]) {
      delete env[key]
    }
    return env
  }
}

class MihomoBatchRuntime {
  private proc: ChildProcessWithoutNullStreams | null = null
  private outputTail = ''
  private procExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private procError: Error | null = null
  private readonly workDir: string
  private readonly configPath: string
  private readonly names = new Map<string, string>()

  constructor(
    private readonly config: AppConfig,
    private readonly nodes: NodeEntity[],
    private readonly mixedPort: number,
    private readonly controllerPort: number
  ) {
    this.workDir = path.join(config.mihomoDir, newId('probe_batch'))
    this.configPath = path.join(this.workDir, 'config.yaml')
  }

  async start(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    fs.mkdirSync(this.workDir, { recursive: true })
    const proxies = this.nodes.flatMap((node, index) => {
      const proxy = toClashProxy(node)
      if (!proxy) return []
      const name = `ProxyNest-${index}-${node.id}`
      this.names.set(node.id, name)
      proxy.name = name
      return [proxy]
    })
    if (!proxies.length) throw new Error('no nodes can be converted to mihomo proxies')
    const proxyNames = proxies.map((proxy) => String(proxy.name))
    const config = {
      'mixed-port': this.mixedPort,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'silent',
      'external-controller': `127.0.0.1:${this.controllerPort}`,
      secret: this.config.mihomoApiSecret,
      proxies,
      'proxy-groups': [
        {
          name: 'ProxyNest',
          type: 'select',
          proxies: proxyNames
        }
      ],
      rules: ['MATCH,ProxyNest']
    }
    fs.writeFileSync(this.configPath, YAML.stringify(config), 'utf8')
    this.proc = spawn(this.config.mihomoBin, ['-f', this.configPath, '-d', this.workDir], {
      env: this.directEnv(),
      windowsHide: true
    })
    this.proc.stdout.on('data', (chunk) => this.captureOutput(chunk))
    this.proc.stderr.on('data', (chunk) => this.captureOutput(chunk))
    this.proc.once('exit', (code, signal) => {
      this.procExit = { code, signal }
    })
    this.proc.once('error', (error) => {
      this.procError = error
    })
    await this.waitReady(timeoutMs, signal)
  }

  stop(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill()
    }
    try {
      fs.rmSync(this.workDir, { recursive: true, force: true })
    } catch {
      // Best effort cleanup only.
    }
  }

  async delay(nodeId: string, timeoutMs: number, signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal)
    const name = this.names.get(nodeId)
    if (!name) return -1
    const url = `${this.controllerUrl()}/proxies/${encodeURIComponent(name)}/delay?timeout=${timeoutMs}&url=${encodeURIComponent('http://www.gstatic.com/generate_204')}`
    const res = await undiciFetch(url, { headers: this.headers(), signal: withTimeoutSignal(timeoutMs + 1000, signal) })
    if (!res.ok) return -1
    const json = (await res.json()) as { delay?: number }
    return typeof json.delay === 'number' ? json.delay : -1
  }

  async select(nodeId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const name = this.names.get(nodeId)
    if (!name) throw new Error(`node ${nodeId} is not loaded in mihomo batch`)
    const res = await undiciFetch(`${this.controllerUrl()}/proxies/ProxyNest`, {
      method: 'PUT',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name }),
      signal: withTimeoutSignal(Math.min(timeoutMs, 3000), signal)
    })
    if (!res.ok) throw new Error(`select proxy HTTP ${res.status}`)
  }

  async downloadBytes(url: string, timeoutMs: number, signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal)
    const agent = new ProxyAgent(`http://127.0.0.1:${this.mixedPort}`)
    try {
      const res = await undiciFetch(url, {
        dispatcher: agent,
        signal: withTimeoutSignal(timeoutMs, signal)
      })
      if (!res.ok) throw new Error(`speed test HTTP ${res.status}`)
      return await readSampleBytes(res, 2 * 1024 * 1024)
    } finally {
      await agent.close().catch(() => undefined)
    }
  }

  async checkHttpsSecurity(timeoutMs: number, signal?: AbortSignal): Promise<SecurityCheck> {
    return checkHttpsSecurityViaProxy(this.mixedPort, timeoutMs, signal)
  }

  private async waitReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      this.throwProcessFailure('mihomo batch did not become ready', lastError)
      try {
        const res = await undiciFetch(`${this.controllerUrl()}/version`, {
          headers: this.headers(),
          signal: withTimeoutSignal(500, signal)
        })
        if (res.ok) return
      } catch (error) {
        lastError = error
      }
      await this.sleep(150, signal)
    }
    this.throwProcessFailure('mihomo batch did not become ready', lastError)
    throw new Error(`mihomo batch did not become ready: ${lastError instanceof Error ? lastError.message : 'timeout'}`)
  }

  private captureOutput(chunk: Buffer | string): void {
    this.outputTail = `${this.outputTail}${String(chunk)}`.slice(-4000)
  }

  private throwProcessFailure(prefix: string, lastError?: unknown): void {
    if (this.procError) {
      throw new Error(`${prefix}: ${this.procError.message}${this.outputDetail(lastError)}`)
    }
    if (this.procExit) {
      const exitText = this.procExit.signal
        ? `exited by signal ${this.procExit.signal}`
        : `exited with code ${this.procExit.code ?? 'unknown'}`
      throw new Error(`${prefix}: mihomo ${exitText}${this.outputDetail(lastError)}`)
    }
  }

  private outputDetail(lastError?: unknown): string {
    const parts: string[] = []
    if (lastError instanceof Error) parts.push(`last controller error: ${lastError.message}`)
    const tail = this.outputTail.trim().replace(/\s+/g, ' ')
    if (tail) parts.push(`mihomo output: ${tail}`)
    return parts.length ? `; ${parts.join('; ')}` : ''
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, ms)
      const abort = () => {
        cleanup()
        reject(abortError())
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private controllerUrl(): string {
    return `http://127.0.0.1:${this.controllerPort}`
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.mihomoApiSecret}`
    }
  }

  private directEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy'
    ]) {
      delete env[key]
    }
    return env
  }
}
