import { TextDecoder } from 'node:util'
import type { AppConfig } from './config'
import type { Store } from './store'
import { parseSubscriptionContent } from './codec'
import type { DedupeMode, DirectoryDiscoveryResult, GithubDiscoveryResult, NormalizedNode, SourceEntity } from './types'
import { newId, runLimited, sha256, throwIfAborted, withTimeoutSignal } from './utils'
import {
  applyGithubRawProxy,
  normalizeSubscriptionUrl,
  stripGithubRawProxyPrefix,
  toGithubRawUrl
} from './urlTools'

type BatchItem = {
  name?: string
  url: string
  autoDeleteFailedFetches?: number | null
}

type RefreshOptions = {
  originalUrl?: string | null
  autoDeleteFailedFetches?: number | null
  discoveredBy?: string | null
  maxNodes?: number
}

type GithubDiscoveryOptions = {
  searchDays: number
  maxRepos: number
  maxCandidates: number
  maxAdditions: number
  concurrency: number
  validateCandidates: boolean
  queries: string[]
  dedupeMode: DedupeMode
}

type GithubRepo = {
  full_name: string
  default_branch?: string
}

type GithubTreeItem = {
  path?: string
  type?: string
}

type GithubTreeResponse = {
  tree?: GithubTreeItem[]
}

type ValidatedGithubCandidate = {
  url: string
  score: number
}

type CuratedSourceSeed = {
  id: string
  name: string
  url: string
  sourceUrl: string
}

const defaultNodeFileNames = new Set([
  'all',
  'sub',
  'subscribe',
  'subscription',
  'base64',
  'clash',
  'v2ray',
  'node',
  'nodes',
  'proxy',
  'proxies'
])

const defaultGithubQueries = [
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

const nodePathPattern =
  /(^|\/)(?:all|base64|clash|clash[-_]?meta|mihomo|node|nodes|proxy|proxies|provider|providers|share|sub|subs|subscribe|subscription|v2ray|v2rayn|list|list_raw)(?:[-_.a-z0-9]*)?\.(?:txt|json|ya?ml)$/i

const ignoredPathPattern =
  /(^|\/)(?:readme|license|package-lock|pnpm-lock|yarn.lock|docker-compose|tsconfig|vite\.config|webpack\.config)(?:\.|$)/i

const curatedSourceSeeds: CuratedSourceSeed[] = [
  {
    id: 'anaer_sub',
    name: 'Anaer Sub',
    url: 'https://anaer.github.io/Sub/clash.yaml',
    sourceUrl: 'https://github.com/anaer/Sub'
  },
  {
    id: 'au1rxx_subscriptions',
    name: 'Au1rxx Free VPN Subscriptions',
    url: 'https://github.com/Au1rxx/free-vpn-subscriptions/raw/main/output/clash.yaml',
    sourceUrl: 'https://github.com/Au1rxx/free-vpn-subscriptions'
  },
  {
    id: 'ermaozi_subscribe',
    name: 'Ermaozi Subscribe',
    url: 'https://github.com/ermaozi/get_subscribe/raw/refs/heads/main/subscribe/clash.yml',
    sourceUrl: 'https://github.com/ermaozi/get_subscribe'
  }
]

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`
  if (bytes >= 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`
  return `${bytes} B`
}

export class SubscriptionService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig
  ) {}

  async addBatch(items: BatchItem[], dedupeMode: DedupeMode): Promise<{
    created: number
    dedupedSources: number
    failed: Array<{ url: string; error: string }>
    stats: {
      rawNodes: number
      uniqueNodes: number
      types: Record<string, number>
    }
  }> {
    let created = 0
    let rawNodes = 0
    let uniqueNodes = 0
    const dedupedBefore = this.dedupeSources()
    const types: Record<string, number> = {}
    const failed: Array<{ url: string; error: string }> = []
    const seenInputUrls = new Set<string>()
    const normalizedItems = items.filter((item) => {
      const normalized = this.normalizeInputUrl(item.url)
      if (seenInputUrls.has(normalized.url)) return false
      seenInputUrls.add(normalized.url)
      return true
    })
    const duplicateInputs = items.length - normalizedItems.length
    if (items.length > this.config.subscriptionMaxBatchItems) {
      throw new Error(`订阅批量导入数量超过上限 ${this.config.subscriptionMaxBatchItems} 条`)
    }
    for (const item of normalizedItems) {
      const normalized = this.normalizeInputUrl(item.url)
      if (rawNodes >= this.config.subscriptionMaxNodesPerBatch) {
        failed.push({
          url: normalized.url,
          error: `批量导入节点数量已达到上限 ${this.config.subscriptionMaxNodesPerBatch} 个`
        })
        continue
      }
      try {
        const remainingNodes = Math.max(1, this.config.subscriptionMaxNodesPerBatch - rawNodes)
        const source = await this.refreshUrl(normalized.url, item.name, {
          originalUrl: normalized.originalUrl,
          autoDeleteFailedFetches: item.autoDeleteFailedFetches,
          maxNodes: remainingNodes
        })
        created += 1
        rawNodes += source.nodeCount
        uniqueNodes = this.store.getAllNodes().length
        for (const [type, count] of Object.entries(source.typeSummary)) {
          types[type] = (types[type] ?? 0) + count
        }
      } catch (error) {
        failed.push({
          url: normalized.url,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    const dedupedAfter = this.dedupeSources()
    this.store.dedupe(dedupeMode)
    uniqueNodes = this.store.getAllNodes().length
    return {
      created,
      dedupedSources: dedupedBefore.removed + dedupedAfter.removed + duplicateInputs,
      failed,
      stats: {
        rawNodes,
        uniqueNodes,
        types
      }
    }
  }

  async refreshSource(id: string): Promise<void> {
    let source = this.store.getSource(id)
    if (!source) throw new Error('subscription not found')
    this.store.clearCurrentNodesForSource(source.id)
    const normalized = this.normalizeInputUrl(source.url)
    if (normalized.url !== source.url || normalized.originalUrl !== source.originalUrl) {
      source = this.store.canonicalizeSourceUrl(
        source.id,
        normalized.url,
        source.originalUrl ?? normalized.originalUrl
      ) ?? source
    }
    await this.refreshUrl(source.url, source.name ?? undefined, {
      originalUrl: source.originalUrl,
      autoDeleteFailedFetches: source.autoDeleteFailedFetches,
      discoveredBy: source.discoveredBy
    })
    this.dedupeSources()
    this.store.dedupe(this.store.getSettings().dedupe.defaultMode)
  }

  async refreshAll(signal?: AbortSignal): Promise<{
    refreshed: number
    failed: number
    deleted: number
    dedupe: { before: number; after: number; removed: number }
    sourceDedupe: { before: number; after: number; removed: number }
  }> {
    let refreshed = 0
    let failed = 0
    let deleted = 0
    const sourceDedupeBefore = this.dedupeSources()
    this.store.clearCurrentNodes()
    for (const sourceSnapshot of this.store.listSources().filter((item) => item.enabled)) {
      throwIfAborted(signal)
      try {
        const normalized = this.normalizeInputUrl(sourceSnapshot.url)
        const source = (normalized.url !== sourceSnapshot.url || normalized.originalUrl !== sourceSnapshot.originalUrl)
          ? this.store.canonicalizeSourceUrl(
            sourceSnapshot.id,
            normalized.url,
            sourceSnapshot.originalUrl ?? normalized.originalUrl
          ) ?? sourceSnapshot
          : sourceSnapshot
        await this.refreshUrl(source.url, source.name ?? undefined, {
          originalUrl: source.originalUrl,
          autoDeleteFailedFetches: source.autoDeleteFailedFetches,
          discoveredBy: source.discoveredBy
        }, signal)
        refreshed += 1
      } catch {
        throwIfAborted(signal)
        failed += 1
        if (!this.store.getSource(sourceSnapshot.id)) deleted += 1
      }
    }
    const sourceDedupeAfter = this.dedupeSources()
    const dedupe = this.store.dedupe(this.store.getSettings().dedupe.defaultMode)
    return {
      refreshed,
      failed,
      deleted,
      dedupe,
      sourceDedupe: {
        before: sourceDedupeBefore.before,
        after: sourceDedupeAfter.after,
        removed: sourceDedupeBefore.removed + sourceDedupeAfter.removed
      }
    }
  }

  async discoverGithubSources(
    input: Partial<GithubDiscoveryOptions> = {},
    signal?: AbortSignal
  ): Promise<GithubDiscoveryResult> {
    throwIfAborted(signal)
    const options = this.discoveryOptions(input)
    const settings = this.store.getSettings()
    const proxyPrefix = settings.github.rawProxyPrefix
    const sourceDedupe = this.dedupeSources(proxyPrefix)
    const existingRawUrls = this.existingRawUrlSet(proxyPrefix)
    const failed: Array<{ url: string; error: string }> = []
    let candidates: string[] = []
    try {
      candidates = await this.collectGithubRawUrls(options, signal)
    } catch (error) {
      throwIfAborted(signal)
      failed.push({ url: this.githubApiBaseUrl(), error: error instanceof Error ? error.message : String(error) })
    }
    const freshCandidates = candidates.filter((url) => !existingRawUrls.has(url))
    const limitedCandidates = freshCandidates.slice(0, options.maxCandidates)
    const validated = options.validateCandidates
      ? (await this.validateGithubCandidates(limitedCandidates, proxyPrefix, options.concurrency, signal)).map((item) => item.url)
      : limitedCandidates
    const toAdd = validated.slice(0, options.maxAdditions)
    const sources: SourceEntity[] = []

    for (const rawUrl of toAdd) {
      throwIfAborted(signal)
      const proxied = applyGithubRawProxy(rawUrl, proxyPrefix)
      try {
        const source = await this.refreshUrl(proxied, this.githubSourceName(rawUrl), {
          originalUrl: rawUrl,
          discoveredBy: 'github'
        }, signal)
        sources.push(source)
      } catch (error) {
        throwIfAborted(signal)
        failed.push({
          url: proxied,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    const sourceDedupeAfter = this.dedupeSources(proxyPrefix)
    this.store.dedupe(options.dedupeMode)
    return {
      searchedRepos: this.lastSearchedRepos,
      candidateUrls: candidates.length,
      validUrls: validated.length,
      added: sources.length,
      skippedExisting: candidates.length - freshCandidates.length,
      failed,
      sources,
      sourceDedupe: {
        before: sourceDedupe.before,
        after: sourceDedupeAfter.after,
        removed: sourceDedupe.removed + sourceDedupeAfter.removed
      }
    }
  }

  async discoverDirectorySources(signal?: AbortSignal): Promise<DirectoryDiscoveryResult> {
    throwIfAborted(signal)
    const sourceDedupe = this.dedupeSources()
    const existingUrls = new Set(this.store.listSources().map((source) => source.url.trim().toLowerCase()))
    const failed: Array<{ url: string; error: string }> = []
    const candidates = curatedSourceSeeds
      .map((seed) => ({ ...seed, normalizedUrl: this.normalizeInputUrl(seed.url).url }))
      .filter((seed) => !existingUrls.has(seed.normalizedUrl.toLowerCase()))

    const validated: Array<(CuratedSourceSeed & { normalizedUrl: string })> = []

    await runLimited(candidates, Math.min(6, Math.max(1, candidates.length)), async (candidate) => {
      throwIfAborted(signal)
      try {
        const text = await this.fetchText(candidate.normalizedUrl, 15000, {}, signal)
        const parsed = parseSubscriptionContent(text, 'directory_probe', { maxNodes: 50 })
        if (parsed.nodes.length > 0) validated.push(candidate)
      } catch (error) {
        throwIfAborted(signal)
        failed.push({
          url: candidate.normalizedUrl,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }, () => Boolean(signal?.aborted))

    const sources: SourceEntity[] = []
    for (const candidate of validated) {
      throwIfAborted(signal)
      try {
        const source = await this.refreshUrl(candidate.normalizedUrl, `${candidate.name}: ${this.shortSourceLabel(candidate.normalizedUrl)}`, {
          originalUrl: candidate.sourceUrl,
          discoveredBy: `curated:${candidate.id}`
        }, signal)
        sources.push(source)
      } catch (error) {
        failed.push({
          url: candidate.normalizedUrl,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    const sourceDedupeAfter = this.dedupeSources()
    this.store.dedupe(this.store.getSettings().dedupe.defaultMode)
    return {
      searchedPages: curatedSourceSeeds.length,
      candidateUrls: curatedSourceSeeds.length,
      validUrls: validated.length,
      added: sources.length,
      skippedExisting: curatedSourceSeeds.length - candidates.length,
      failed,
      sources,
      sourceDedupe: {
        before: sourceDedupe.before,
        after: sourceDedupeAfter.after,
        removed: sourceDedupe.removed + sourceDedupeAfter.removed
      }
    }
  }

  private lastSearchedRepos = 0

  private normalizeInputUrl(url: string): { url: string; originalUrl: string | null } {
    const settings = this.store.getSettings()
    const normalized = normalizeSubscriptionUrl(url, settings.github.rawProxyPrefix)
    return {
      url: normalized.url,
      originalUrl: normalized.originalUrl
    }
  }

  private async refreshUrl(
    url: string,
    name?: string,
    options: RefreshOptions = {},
    signal?: AbortSignal
  ): Promise<SourceEntity> {
    const sourceId = this.store.getSourceByUrl(url)?.id ?? newId('sub')
    try {
      const text = await this.fetchText(url, 20000, {}, signal)
      const maxNodes = Math.min(
        this.config.subscriptionMaxNodesPerSource,
        options.maxNodes ?? this.config.subscriptionMaxNodesPerSource
      )
      const parsed = parseSubscriptionContent(text, sourceId, { maxNodes })
      if (parsed.truncated) {
        throw new Error(`订阅节点数量超过上限 ${maxNodes} 个，请拆分订阅或调高 SUBSCRIPTION_MAX_NODES_PER_SOURCE / SUBSCRIPTION_MAX_NODES_PER_BATCH`)
      }
      if (!parsed.nodes.length) {
        const source = this.store.upsertSource({
          id: sourceId,
          name: name ?? null,
          url,
          originalUrl: options.originalUrl,
          valid: false,
          nodeCount: 0,
          typeSummary: {},
          lastError: 'no supported nodes found',
          autoDeleteFailedFetches: options.autoDeleteFailedFetches,
          discoveredBy: options.discoveredBy,
          contentSignature: null
        })
        this.store.deleteSourceIfExceededFailures(source.id)
        throw new Error(source.lastError || 'no supported nodes found')
      }
      const source = this.store.upsertSource({
        id: sourceId,
        name: name ?? null,
        url,
        originalUrl: options.originalUrl,
        valid: true,
        nodeCount: parsed.nodes.length,
        typeSummary: parsed.typeSummary,
        lastError: null,
        autoDeleteFailedFetches: options.autoDeleteFailedFetches,
        discoveredBy: options.discoveredBy,
        contentSignature: this.contentSignature(parsed.nodes)
      })
      this.store.upsertNodes(source.id, parsed.nodes)
      return this.store.getSource(source.id)!
    } catch (error) {
      if (error instanceof Error && error.message === 'no supported nodes found') throw error
      const source = this.store.upsertSource({
        id: sourceId,
        name: name ?? null,
        url,
        originalUrl: options.originalUrl,
        valid: false,
        nodeCount: 0,
        typeSummary: {},
        lastError: error instanceof Error ? error.message : String(error),
        autoDeleteFailedFetches: options.autoDeleteFailedFetches,
        discoveredBy: options.discoveredBy,
        contentSignature: null
      })
      this.store.deleteSourceIfExceededFailures(source.id)
      throw new Error(source.lastError || 'fetch failed')
    }
  }

  private async fetchText(
    url: string,
    timeoutMs: number,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
    maxBytes = this.config.subscriptionMaxBytes
  ): Promise<string> {
    throwIfAborted(signal)
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ProxyNest/0.1',
        ...headers
      },
      signal: withTimeoutSignal(timeoutMs, signal)
    })
    if (!response.ok) {
      const detail = await this.readResponseText(response, Math.min(maxBytes, 64 * 1024)).catch(() => '')
      throw new Error(this.httpErrorMessage(response.status, detail))
    }
    const lengthHeader = response.headers.get('content-length')
    const declaredLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : 0
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`订阅文件过大：${formatBytes(declaredLength)}，上限 ${formatBytes(maxBytes)}`)
    }
    return this.readResponseText(response, maxBytes)
  }

  private async readResponseText(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) {
      const text = await response.text()
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > maxBytes) throw new Error(`响应内容过大：${formatBytes(bytes)}，上限 ${formatBytes(maxBytes)}`)
      return text
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let received = 0
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.byteLength
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`响应内容过大：超过 ${formatBytes(maxBytes)} 上限`)
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  }

  private httpErrorMessage(status: number, detail: string): string {
    const trimmed = detail.trim()
    if (!trimmed) return `HTTP ${status}`
    try {
      const json = JSON.parse(trimmed) as { message?: string; documentation_url?: string }
      const message = json.message ? `: ${json.message}` : ''
      const docs = json.documentation_url ? ` (${json.documentation_url})` : ''
      return `HTTP ${status}${message}${docs}`
    } catch {
      return `HTTP ${status}: ${trimmed.slice(0, 300)}`
    }
  }

  private discoveryOptions(input: Partial<GithubDiscoveryOptions>): GithubDiscoveryOptions {
    const settings = this.store.getSettings()
    const base = settings.github.discovery
    return {
      searchDays: this.positiveInt(input.searchDays, base.searchDays),
      maxRepos: this.positiveInt(input.maxRepos, base.maxRepos),
      maxCandidates: this.positiveInt(input.maxCandidates, base.maxCandidates),
      maxAdditions: this.positiveInt(input.maxAdditions, base.maxAdditions),
      concurrency: this.positiveInt(input.concurrency, base.concurrency),
      validateCandidates: input.validateCandidates ?? base.validateCandidates,
      queries: input.queries?.length ? input.queries : base.queries.length ? base.queries : defaultGithubQueries,
      dedupeMode: input.dedupeMode ?? settings.dedupe.defaultMode
    }
  }

  private positiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
  }

  private async collectGithubRawUrls(options: GithubDiscoveryOptions, signal?: AbortSignal): Promise<string[]> {
    const found = new Set<string>()
    const repos = new Map<string, GithubRepo>()
    this.lastSearchedRepos = 0
    for (const query of options.queries) {
      throwIfAborted(signal)
      if (repos.size >= options.maxRepos) break
      for (const repo of await this.searchRepos(query, options.searchDays, signal)) {
        if (repos.size >= options.maxRepos) break
        repos.set(repo.full_name, repo)
      }
    }
    const repoList = [...repos.values()]
    this.lastSearchedRepos = repoList.length
    await runLimited(repoList, Math.min(options.concurrency, 6), async (repo) => {
      throwIfAborted(signal)
      if (found.size >= options.maxCandidates) return
      const branch = repo.default_branch || 'main'
      const paths = await this.listRepoNodePaths(repo, branch, signal)
      for (const filePath of paths) {
        if (found.size >= options.maxCandidates) break
        found.add(this.rawGithubUrl(repo.full_name, branch, filePath))
      }
    }, () => Boolean(signal?.aborted))
    return [...found]
  }

  private async searchRepos(query: string, searchDays: number, signal?: AbortSignal): Promise<GithubRepo[]> {
    const since = new Date(Date.now() - searchDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const fullQuery = `${query} pushed:>${since} archived:false`
    const url = `${this.githubApiBaseUrl()}/search/repositories?q=${encodeURIComponent(fullQuery)}&sort=updated&order=desc&per_page=30`
    const json = await this.fetchGithubJson<{ items?: GithubRepo[] }>(url, signal)
    return json.items ?? []
  }

  private async listRepoNodePaths(repo: GithubRepo, branch: string, signal?: AbortSignal): Promise<string[]> {
    const url = `${this.githubApiBaseUrl()}/repos/${encodeURIComponent(repo.full_name).replace('%2F', '/')}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    try {
      const json = await this.fetchGithubJson<GithubTreeResponse>(url, signal)
      return (json.tree ?? [])
        .filter((item) => item.type === 'blob' && item.path && this.isLikelyNodePath(item.path))
        .map((item) => item.path!)
        .slice(0, 12)
    } catch {
      throwIfAborted(signal)
      return this.fallbackNodePaths()
    }
  }

  private fallbackNodePaths(): string[] {
    return [
      'v2ray.txt',
      'clash.yaml',
      'clash.yml',
      'sub.txt',
      'sub',
      'nodes.txt',
      'node.txt',
      'all.yaml',
      'all.txt',
      'base64.txt',
      'list.txt',
      'proxies.yaml',
      'subscribe.txt'
    ]
  }

  private isLikelyNodePath(filePath: string): boolean {
    const lower = filePath.toLowerCase()
    if (ignoredPathPattern.test(lower)) return false
    if (nodePathPattern.test(lower)) return true
    const filename = lower.split('/').pop() ?? ''
    return defaultNodeFileNames.has(filename)
  }

  private rawGithubUrl(fullName: string, branch: string, filePath: string): string {
    return `https://raw.githubusercontent.com/${fullName}/${branch}/${filePath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`
  }

  private async validateGithubCandidates(
    rawUrls: string[],
    proxyPrefix: string,
    concurrency: number,
    signal?: AbortSignal
  ): Promise<ValidatedGithubCandidate[]> {
    const valid: ValidatedGithubCandidate[] = []
    await runLimited(rawUrls, concurrency, async (rawUrl) => {
      throwIfAborted(signal)
      const proxied = applyGithubRawProxy(rawUrl, proxyPrefix)
      try {
        const text = await this.fetchText(proxied, 15000, {}, signal)
        const parsed = parseSubscriptionContent(text, 'github_probe', { maxNodes: 50 })
        const diversity = Object.keys(parsed.typeSummary).length
        const score = parsed.nodes.length * 10 + diversity * 20
        if (parsed.nodes.length > 0) valid.push({ url: rawUrl, score })
      } catch {
        throwIfAborted(signal)
        // Ignore invalid candidates; the result summary reports only URLs that survived validation.
      }
    }, () => Boolean(signal?.aborted))
    return valid.sort((a, b) => b.score - a.score)
  }

  private existingRawUrlSet(proxyPrefix: string): Set<string> {
    return new Set(
      this.store.listSources().flatMap((source) => [
        stripGithubRawProxyPrefix(source.url, proxyPrefix),
        source.originalUrl ? stripGithubRawProxyPrefix(source.originalUrl, proxyPrefix) : ''
      ]).filter(Boolean)
    )
  }

  private dedupeSources(proxyPrefix = this.store.getSettings().github.rawProxyPrefix): {
    before: number
    after: number
    removed: number
  } {
    const sources = this.store.listSources()
    const before = sources.length
    const seen = new Map<string, SourceEntity>()
    const removeIds: string[] = []
    for (const source of sources) {
      const key = this.sourceDedupeKeys(source, proxyPrefix).find((candidateKey) => seen.has(candidateKey))
        ?? this.sourceDedupeKeys(source, proxyPrefix)[0]
      const previous = seen.get(key)
      if (!previous) {
        for (const candidateKey of this.sourceDedupeKeys(source, proxyPrefix)) seen.set(candidateKey, source)
        continue
      }
      const keep = this.pickBetterSource(previous, source)
      const drop = keep.id === previous.id ? source : previous
      for (const candidateKey of this.sourceDedupeKeys(keep, proxyPrefix)) seen.set(candidateKey, keep)
      removeIds.push(drop.id)
    }
    for (const id of removeIds) {
      this.store.deleteSource(id)
    }
    return {
      before,
      after: before - removeIds.length,
      removed: removeIds.length
    }
  }

  private sourceDedupeKeys(source: SourceEntity, proxyPrefix: string): string[] {
    const keys: string[] = []
    if (source.valid && source.contentSignature) {
      keys.push(`content:${source.contentSignature}`)
      const weakKey = this.sourceWeakContentKey(source, proxyPrefix)
      if (weakKey) keys.push(weakKey)
    }
    const rawUrl = source.originalUrl || source.url
    const withoutProxy = stripGithubRawProxyPrefix(rawUrl, proxyPrefix)
    keys.push(toGithubRawUrl(withoutProxy).trim().replace(/\/+$/, '').toLowerCase())
    return keys
  }

  private sourceWeakContentKey(source: SourceEntity, proxyPrefix: string): string | null {
    if (!source.valid || source.nodeCount <= 0) return null
    const rawUrl = stripGithubRawProxyPrefix(source.originalUrl || source.url, proxyPrefix)
    const githubRaw = toGithubRawUrl(rawUrl)
    const repoKey = this.githubRepoKey(githubRaw)
    if (!repoKey) return null
    const typeSummary = Object.entries(source.typeSummary)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, count]) => `${type}:${count}`)
      .join(',')
    return `repo-content:${repoKey}:${source.nodeCount}:${typeSummary}`
  }

  private githubRepoKey(url: string): string | null {
    try {
      const parsed = new URL(url)
      if (parsed.hostname !== 'raw.githubusercontent.com') return null
      const [owner, repo] = parsed.pathname.split('/').filter(Boolean)
      if (!owner || !repo) return null
      return `${owner}/${repo}`.toLowerCase()
    } catch {
      return null
    }
  }

  private contentSignature(nodes: NormalizedNode[]): string {
    return sha256(nodes.map((node) => node.fingerprint).sort().join('\n'))
  }

  private pickBetterSource(a: SourceEntity, b: SourceEntity): SourceEntity {
    const score = (source: SourceEntity): number => {
      const successAt = source.lastSuccessAt ? Date.parse(source.lastSuccessAt) || 0 : 0
      return (
        (source.enabled ? 100000 : 0) +
        (source.valid ? 10000 : 0) +
        source.nodeCount * 10 -
        source.failedFetchCount * 100 +
        Math.floor(successAt / 100000000)
      )
    }
    return score(b) > score(a) ? b : a
  }

  private githubSourceName(rawUrl: string): string {
    try {
      const url = new URL(rawUrl)
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length >= 5) return `${parts[0]}/${parts[1]}:${parts.slice(4).join('/')}`
    } catch {
      // Fall through.
    }
    return 'GitHub discovered subscription'
  }

  private shortSourceLabel(url: string): string {
    try {
      const parsed = new URL(url)
      return `${parsed.hostname}${parsed.pathname}`.slice(0, 120)
    } catch {
      return url.slice(0, 120)
    }
  }

  private githubApiBaseUrl(): string {
    return (this.store.getSettings().github.apiBaseUrl || 'https://api.github.com').trim().replace(/\/+$/, '') || 'https://api.github.com'
  }

  private async fetchGithubJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const settings = this.store.getSettings()
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json'
    }
    if (settings.github.token) headers.Authorization = `Bearer ${settings.github.token}`
    const text = await this.fetchText(url, 15000, headers, signal, Math.max(this.config.subscriptionMaxBytes, 16 * 1024 * 1024))
    return JSON.parse(text) as T
  }
}
