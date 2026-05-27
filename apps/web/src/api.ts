import type {
  ApiResponse,
  AppSettings,
  ArtifactEntity,
  DashboardSummary,
  DedupeMode,
  FullRunParams,
  DirectoryDiscoveryResult,
  GithubDiscoveryResult,
  NodeEntity,
  PageResult,
  ReusableNodeEntity,
  SourceEntity,
  TestRunEntity
} from './types'

class ApiClient {
  private baseUrl = this.defaultBaseUrl()

  setBaseUrl(url: string) {
    this.baseUrl = url
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers = {
      ...(options.headers as Record<string, string> ?? {})
    }
    if (options.body != null && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json'
    }
    const res = await this.fetchWithLocalFallback(path, { ...options, headers })
    if (res.status === 401 && !path.includes('/auth/')) {
      window.location.href = '/login'
      throw new Error('Unauthorized')
    }
    const json = (await res.json()) as ApiResponse<T>
    if (!json.ok) throw new Error(json.error?.message ?? 'Unknown error')
    return json.data as T
  }

  private async fetchWithLocalFallback(path: string, options: RequestInit): Promise<Response> {
    const tried = new Set<string>()
    let lastError: unknown
    for (const base of this.baseCandidates()) {
      if (tried.has(base)) continue
      tried.add(base)
      try {
        const res = await fetch(`${base}${path}`, {
          ...options,
          credentials: 'include'
        })
        this.baseUrl = base
        return res
      } catch (error) {
        lastError = error
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown')
    throw new Error(`请求后端失败，请确认后端已启动并可访问 http://127.0.0.1:8080。最后错误：${detail}`)
  }

  private baseCandidates(): string[] {
    const candidates = [this.baseUrl]
    if (typeof window === 'undefined') return candidates
    const { protocol, hostname, port } = window.location
    const isFile = protocol === 'file:'
    const isDevWeb = port === '5173'
    if (isFile || isDevWeb) {
      const host = hostname && hostname !== '0.0.0.0' ? hostname : '127.0.0.1'
      candidates.push(`http://${host}:8080`)
    }
    candidates.push('http://127.0.0.1:8080', 'http://localhost:8080', '')
    return candidates
  }

  private defaultBaseUrl(): string {
    if (typeof window === 'undefined') return ''
    const envBase = import.meta.env.VITE_API_BASE_URL as string | undefined
    if (envBase) return envBase.replace(/\/+$/, '')
    const { protocol, hostname, port } = window.location
    if (protocol === 'file:') return 'http://127.0.0.1:8080'
    if (port === '5173') {
      const host = hostname && hostname !== '0.0.0.0' ? hostname : '127.0.0.1'
      return `http://${host}:8080`
    }
    return ''
  }

  auth = {
    login: (password: string) =>
      this.request<{ user: { id: string } }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password })
      }),
    logout: () =>
      this.request<boolean>('/api/auth/logout', { method: 'POST' }),
    me: () =>
      this.request<{ user: { id: string } }>('/api/auth/me'),
    changePassword: (oldPassword: string, newPassword: string) =>
      this.request<boolean>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword, newPassword })
      })
  }

  dashboard = {
    summary: () =>
      this.request<DashboardSummary>('/api/dashboard/summary')
  }

  subscriptions = {
    list: () =>
      this.request<{ items: SourceEntity[] }>('/api/subscriptions'),
    batch: (
      items: Array<{ name?: string; url: string; autoDeleteFailedFetches?: number | null }>,
      dedupeMode: DedupeMode
    ) =>
      this.request<{
        created: number
        dedupedSources: number
        failed: Array<{ url: string; error: string }>
        stats: { rawNodes: number; uniqueNodes: number; types: Record<string, number> }
      }>('/api/subscriptions/batch', {
        method: 'POST',
        body: JSON.stringify({ items, dedupeMode })
      }),
    update: (id: string, patch: { name?: string; enabled?: boolean; autoDeleteFailedFetches?: number | null }) =>
      this.request<SourceEntity>(`/api/subscriptions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch)
      }),
    delete: (id: string) =>
      this.request<boolean>(`/api/subscriptions/${id}`, { method: 'DELETE' }),
    refresh: (id: string) =>
      this.request<SourceEntity>(`/api/subscriptions/${id}/refresh`, { method: 'POST' }),
    refreshAll: () =>
      this.request<{
        refreshed: number
        failed: number
        deleted: number
        dedupe: { before: number; after: number; removed: number }
        sourceDedupe: { before: number; after: number; removed: number }
      }>(
        '/api/subscriptions/refresh-all',
        { method: 'POST' }
      ),
    discoverGithub: (params: Record<string, unknown> = {}) =>
      this.request<GithubDiscoveryResult>('/api/subscriptions/discover-github', {
        method: 'POST',
        body: JSON.stringify(params)
      }),
    discoverDirectory: () =>
      this.request<DirectoryDiscoveryResult>('/api/subscriptions/discover-directory', {
        method: 'POST'
      })
  }

  reusableNodes = {
    list: (params: Record<string, string | number | undefined> = {}) => {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') query.set(key, String(value))
      }
      return this.request<PageResult<ReusableNodeEntity>>(`/api/reusable-nodes?${query}`)
    },
    get: (id: string) =>
      this.request<ReusableNodeEntity>(`/api/reusable-nodes/${id}`),
    patch: (id: string, keepForReprobe: boolean) =>
      this.request<ReusableNodeEntity>(`/api/reusable-nodes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ keepForReprobe })
      }),
    delete: (id: string) =>
      this.request<boolean>(`/api/reusable-nodes/${id}`, { method: 'DELETE' }),
    recheck: (id: string) =>
      this.request<{ runId: string }>(`/api/reusable-nodes/${id}/recheck`, { method: 'POST' }),
    exportUrl: (params: Record<string, string | number | undefined>, format: string) => {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') query.set(key, String(value))
      }
      query.set('format', format)
      return `/api/reusable-nodes/export?${query}`
    }
  }

  nodes = {
    list: (params: Record<string, string | number | undefined>) => {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') query.set(key, String(value))
      }
      return this.request<PageResult<NodeEntity>>(`/api/nodes?${query}`)
    },
    get: (id: string) =>
      this.request<NodeEntity>(`/api/nodes/${id}`),
    delete: (id: string) =>
      this.request<boolean>(`/api/nodes/${id}`, { method: 'DELETE' }),
    recheck: (id: string) =>
      this.request<{ runId: string }>(`/api/nodes/${id}/recheck`, { method: 'POST' }),
    speedtest: (id: string) =>
      this.request<{ runId: string }>(`/api/nodes/${id}/speedtest`, { method: 'POST' }),
    dedupe: (mode: DedupeMode) =>
      this.request<{ before: number; after: number; removed: number }>('/api/nodes/dedupe', {
        method: 'POST',
        body: JSON.stringify({ mode })
      }),
    exportUrl: (params: Record<string, string | number | undefined>, format: string) => {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') query.set(key, String(value))
      }
      query.set('format', format)
      return `/api/nodes/export?${query}`
    }
  }

  runs = {
    full: (params: Partial<FullRunParams>) =>
      this.request<{ runId: string }>('/api/runs/full', {
        method: 'POST',
        body: JSON.stringify(params)
      }),
    alive: (params: Record<string, unknown>) =>
      this.request<{ runId: string }>('/api/runs/alive', {
        method: 'POST',
        body: JSON.stringify(params)
      }),
    speed: (params: Record<string, unknown>) =>
      this.request<{ runId: string }>('/api/runs/speed', {
        method: 'POST',
        body: JSON.stringify(params)
      }),
    unlock: (params: Record<string, unknown>) =>
      this.request<{ runId: string }>('/api/runs/unlock', {
        method: 'POST',
        body: JSON.stringify(params)
      }),
    countryBackup: (params: Record<string, unknown>) =>
      this.request<{ runId: string }>('/api/runs/country-backup', {
        method: 'POST',
        body: JSON.stringify(params)
      }),
    list: (page = 1, pageSize = 20) =>
      this.request<PageResult<TestRunEntity>>(`/api/runs?page=${page}&pageSize=${pageSize}`),
    get: (id: string) =>
      this.request<TestRunEntity>(`/api/runs/${id}`),
    cancel: (id: string) =>
      this.request<boolean>(`/api/runs/${id}/cancel`, { method: 'POST' }),
    pause: (id: string) =>
      this.request<boolean>(`/api/runs/${id}/pause`, { method: 'POST' }),
    resume: (id: string) =>
      this.request<boolean>(`/api/runs/${id}/resume`, { method: 'POST' }),
    clearHistory: () =>
      this.request<{ deleted: number }>('/api/runs/history', { method: 'DELETE' }),
    events: (id: string, onMessage: (data: unknown) => void): () => void => {
      const es = new EventSource(`${this.baseUrl || this.defaultBaseUrl()}/api/runs/${id}/events`, { withCredentials: true })
      es.addEventListener('progress', (e) => {
        try { onMessage(JSON.parse(e.data)) } catch { /* */ }
      })
      es.onerror = () => es.close()
      return () => es.close()
    }
  }

  artifacts = {
    list: () =>
      this.request<{ items: ArtifactEntity[] }>('/api/artifacts')
  }

  settings = {
    get: () =>
      this.request<AppSettings>('/api/settings'),
    patch: (patch: Record<string, unknown>) =>
      this.request<AppSettings>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch)
      }),
    regenerateSubToken: () =>
      this.request<{ items: ArtifactEntity[] }>('/api/settings/sub-token/regenerate', { method: 'POST' }),
    testTelegram: () =>
      this.request<boolean>('/api/settings/telegram/test', { method: 'POST' }),
    updateGeoip: () =>
      this.request<{ updatedAt: string; bytes: number; settings: AppSettings }>('/api/settings/geoip/update', { method: 'POST' })
  }
}

export const api = new ApiClient()
