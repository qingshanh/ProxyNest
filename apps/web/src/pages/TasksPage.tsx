import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { AppSettings, RunProgress, RunStage, TestRunEntity, UnlockPlatform } from '../types'

const terminalStatuses = new Set(['success', 'failed', 'cancelled'])
const taskConfigKey = 'proxynest_task_config_v1'

const defaultFullParams = {
  dedupeMode: 'endpoint' as string,
  aliveConcurrency: 300,
  aliveTimeoutMs: 30000,
  speedEnabled: true,
  speedConcurrency: 4,
  speedMinMBps: 3,
  speedTargetCount: 50,
  speedTestUrl: 'https://speed.cloudflare.com/__down?bytes=1048576',
  speedTimeoutMs: 30000,
  unlockEnabled: true,
  unlockPlatforms: ['openai', 'youtube', 'netflix', 'disney'] as UnlockPlatform[],
  unlockConcurrency: 40,
  unlockTimeoutMs: 30000,
  countryBackupEnabled: true,
  countryPerCountry: 2,
  notifyTelegram: true
}

const defaultStandaloneParams = {
  aliveConcurrency: 300,
  aliveTimeoutMs: 30000,
  speedConcurrency: 4,
  speedMinMBps: 3,
  speedTargetCount: 50,
  speedTestUrl: 'https://speed.cloudflare.com/__down?bytes=1048576',
  speedTimeoutMs: 30000,
  unlockPlatforms: ['openai', 'youtube', 'netflix', 'disney'] as UnlockPlatform[],
  unlockConcurrency: 40,
  unlockTimeoutMs: 30000
}

const loadSavedTaskConfig = () => {
  try {
    const raw = localStorage.getItem(taskConfigKey)
    const saved = JSON.parse(raw || '{}') as {
      fullParams?: Partial<typeof defaultFullParams>
      standaloneParams?: Partial<typeof defaultStandaloneParams>
    }
    return {
      hasSaved: Boolean(raw),
      fullParams: {
        ...defaultFullParams,
        ...saved.fullParams,
        dedupeMode: saved.fullParams?.dedupeMode === 'normalized_config'
          ? 'endpoint'
          : saved.fullParams?.dedupeMode ?? defaultFullParams.dedupeMode
      },
      standaloneParams: { ...defaultStandaloneParams, ...saved.standaloneParams }
    }
  } catch {
    return { hasSaved: false, fullParams: defaultFullParams, standaloneParams: defaultStandaloneParams }
  }
}

const taskDefaultsFromSettings = (settings: AppSettings) => ({
  fullParams: {
    ...defaultFullParams,
    dedupeMode: settings.dedupe.defaultMode,
    aliveConcurrency: settings.concurrency.aliveRecommended,
    aliveTimeoutMs: settings.probeTimeouts.aliveMs,
    speedConcurrency: settings.concurrency.speedRecommended,
    speedMinMBps: settings.reusablePool.minSpeedMBps,
    speedTimeoutMs: settings.probeTimeouts.speedMs,
    unlockConcurrency: settings.concurrency.unlockRecommended,
    unlockTimeoutMs: settings.probeTimeouts.unlockMs
  },
  standaloneParams: {
    ...defaultStandaloneParams,
    aliveConcurrency: settings.concurrency.aliveRecommended,
    aliveTimeoutMs: settings.probeTimeouts.aliveMs,
    speedConcurrency: settings.concurrency.speedRecommended,
    speedMinMBps: settings.reusablePool.minSpeedMBps,
    speedTimeoutMs: settings.probeTimeouts.speedMs,
    unlockConcurrency: settings.concurrency.unlockRecommended,
    unlockTimeoutMs: settings.probeTimeouts.unlockMs
  }
})

const statusLabel: Record<string, string> = {
  queued: '排队中', running: '运行中', paused: '已暂停', success: '成功', failed: '失败', cancelled: '已取消'
}
const statusBadge: Record<string, string> = {
  queued: 'badge-warning', running: 'badge-info', paused: 'badge-warning', success: 'badge-success', failed: 'badge-danger', cancelled: 'badge-dim'
}
const typeLabel: Record<string, string> = {
  full: '全量', alive: '测活', speed: '测速', unlock: '解锁', country_backup: '国家备份', fetch: '拉取'
}
const stageLabel: Record<RunStage, string> = {
  discover: 'GitHub 发现', fetch: '拉取订阅', dedupe: '节点去重', alive: '测活',
  speed: '测速', unlock: '解锁检测', country_backup: '国家备份', artifact: '生成订阅', notify: '发送通知'
}

const renderProgressNodes = (progress: RunProgress | null | undefined) => {
  if (!progress?.active?.length && !progress?.recent?.length) return null
  const resultText = (item: NonNullable<RunProgress['active']>[number]) => {
    if (item.status === 'running') return '进行中'
    if (item.alive != null) return `${item.alive ? '存活' : '失败'}${item.latencyMs != null ? ` ${item.latencyMs}ms` : ''}`
    if (item.speedMBps != null) return `${item.speedMBps} MB/s`
    if (item.unlockAvailable != null) return `${item.platform ?? 'unlock'} ${item.unlockAvailable ? '可用' : '不可用'}${item.region ? ` ${item.region}` : ''}`
    return item.status === 'success' ? '成功' : '失败'
  }
  const renderItems = (items: NonNullable<RunProgress['active']>) => (
    <div style={{ display: 'grid', gap: 6 }}>
      <style>{`@media (max-width: 768px) { .progress-item { grid-template-columns: 1fr !important; } .progress-item span:last-child { justify-self: start !important; } }`}</style>
      {items.map((item) => (
        <div className="progress-item" key={`${item.action}-${item.id}-${item.updatedAt}`}
             style={{ display: 'grid', gridTemplateColumns: '80px 1fr auto', gap: 8, alignItems: 'center', fontSize: '.82em',
                      padding: '6px 10px', borderRadius: 6, background: 'var(--c-bg)' }}>
          <span className={`badge ${item.status === 'running' ? 'badge-info' : item.status === 'success' ? 'badge-success' : 'badge-danger'}`}>
            {item.action}
          </span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={`${item.name} ${item.server}:${item.port}${item.detail ? ` - ${item.detail}` : ''}`}>
            {item.name} · {item.protocol} · {item.server}:{item.port}
          </span>
          <span style={{ color: 'var(--c-text-dim)', whiteSpace: 'nowrap' }}>{resultText(item)}</span>
        </div>
      ))}
    </div>
  )
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {Boolean(progress.active?.length) && (
        <div>
          <div style={{ fontSize: '.82em', fontWeight: 600, color: 'var(--c-text-dim)', marginBottom: 6 }}>正在测试</div>
          {renderItems(progress.active!)}
        </div>
      )}
      {Boolean(progress.recent?.length) && (
        <div>
          <div style={{ fontSize: '.82em', fontWeight: 600, color: 'var(--c-text-dim)', marginBottom: 6 }}>最近结果</div>
          {renderItems(progress.recent!)}
        </div>
      )}
    </div>
  )
}

/* ---- Modal Components ---- */

function ProgressModal({
  run, onClose, onPause, onResume
}: {
  run: RunProgress; onClose: () => void; onPause: (id: string) => void; onResume: (id: string) => void
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal task-modal" style={{ minWidth: 520, maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            任务进度
          </h2>
          <style>{`@media (max-width: 768px) { .task-modal { min-width: auto !important; max-width: 95vw !important; } }`}</style>
          <button className="btn btn-ghost btn-xs" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            关闭
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span className={`badge ${statusBadge[run.status]}`}>{statusLabel[run.status]}</span>
          {run.stage && <span className="badge badge-info">{stageLabel[run.stage] || run.stage}</span>}
          {!terminalStatuses.has(run.status) && (
            run.status === 'paused'
              ? <button className="btn btn-primary btn-xs" onClick={() => onResume(run.runId)}>继续</button>
              : <button className="btn btn-ghost btn-xs" onClick={() => onPause(run.runId)}>暂停</button>
          )}
        </div>
        <div style={{ color: 'var(--c-text-dim)', fontSize: '.9em', marginBottom: 12 }}>{run.message || '-'}</div>
        {run.current != null && run.total != null && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: '.85em' }}>
              <span>{run.current} / {run.total}</span>
              <span style={{ fontWeight: 600 }}>{run.total > 0 ? Math.round((run.current / run.total) * 100) : 0}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${run.total > 0 ? (run.current / run.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        {run.stats && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {Object.entries(run.stats).map(([key, value]) => (
              <span key={key} className="badge badge-dim">{key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
            ))}
          </div>
        )}
        {renderProgressNodes(run)}
        {terminalStatuses.has(run.status) && (
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 18, width: '100%' }} onClick={onClose}>关闭</button>
        )}
      </div>
    </div>
  )
}

function DetailModal({ run, onClose }: { run: TestRunEntity; onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal detail-modal" style={{ minWidth: 520, maxWidth: 700 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            任务详情
          </h2>
          <style>{`@media (max-width: 768px) { .detail-modal { min-width: auto !important; max-width: 95vw !important; } }`}</style>
          <button className="btn btn-ghost btn-xs" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            关闭
          </button>
        </div>
        <div style={{ fontSize: '.8em', fontFamily: 'monospace', color: 'var(--c-text-dim)', marginBottom: 12 }}>{run.id}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <span className="badge badge-dim">{typeLabel[run.type] || run.type}</span>
          <span className={`badge ${statusBadge[run.status]}`}>{statusLabel[run.status]}</span>
          {run.progress?.stage && <span className="badge badge-info">{stageLabel[run.progress.stage] || run.progress.stage}</span>}
          {run.progress?.current != null && run.progress?.total != null && (
            <span className="badge badge-dim">{run.progress.current} / {run.progress.total}</span>
          )}
        </div>
        <div style={{ display: 'grid', gap: 8, marginBottom: 16, fontSize: '.9em' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--c-text-dim)', minWidth: 70 }}>状态：</span>
            <span>{run.progress?.message || run.error || '-'}</span>
          </div>
          {run.error && (
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--c-text-dim)', minWidth: 70 }}>失败原因：</span>
              <span style={{ color: 'var(--c-danger)' }}>{run.error}</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--c-text-dim)', minWidth: 70 }}>开始：</span>
            <span>{run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : '-'}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--c-text-dim)', minWidth: 70 }}>结束：</span>
            <span>{run.finishedAt ? new Date(run.finishedAt).toLocaleString('zh-CN') : '-'}</span>
          </div>
        </div>
        {run.progress && run.progress.current != null && run.progress.total != null && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: '.85em' }}>
              <span>{run.progress.current} / {run.progress.total}</span>
              <span style={{ fontWeight: 600 }}>{run.progress.total > 0 ? Math.round((run.progress.current / run.progress.total) * 100) : 0}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${run.progress.total > 0 ? (run.progress.current / run.progress.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        {renderProgressNodes(run.progress)}
        <div className="grid-2" style={{ marginTop: 16 }}>
          <div>
            <div style={{ fontSize: '.85em', fontWeight: 600, color: 'var(--c-text-dim)', marginBottom: 6 }}>统计</div>
            <pre style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 180, fontSize: '.8em',
                          background: 'var(--c-bg)', padding: 10, borderRadius: 6 }}>{JSON.stringify(run.stats ?? {}, null, 2)}</pre>
          </div>
          <div>
            <div style={{ fontSize: '.85em', fontWeight: 600, color: 'var(--c-text-dim)', marginBottom: 6 }}>启动参数</div>
            <pre style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 180, fontSize: '.8em',
                          background: 'var(--c-bg)', padding: 10, borderRadius: 6 }}>{JSON.stringify(run.params ?? {}, null, 2)}</pre>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---- Main Page ---- */

export function TasksPage() {
  const [runs, setRuns] = useState<TestRunEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [activeRun, setActiveRun] = useState<RunProgress | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [detailRun, setDetailRun] = useState<TestRunEntity | null>(null)
  const closeRef = useRef<(() => void) | null>(null)
  const pendingProgressRef = useRef<RunProgress | null>(null)
  const progressTimerRef = useRef<number | null>(null)
  const pollTimerRef = useRef<number | null>(null)
  // Track whether user dismissed the progress modal so we don't re-show it
  const progressDismissedRef = useRef(false)

  const savedTaskConfigRef = useRef(loadSavedTaskConfig())
  const [fullParams, setFullParams] = useState(savedTaskConfigRef.current.fullParams)
  const [standaloneParams, setStandaloneParams] = useState(savedTaskConfigRef.current.standaloneParams)

  const fetchRuns = useCallback(async () => {
    try { setRuns((await api.runs.list(1, 30)).items) } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchRuns() }, [fetchRuns])
  useEffect(() => {
    if (savedTaskConfigRef.current.hasSaved) return
    let cancelled = false
    api.settings.get()
      .then((settings) => {
        if (cancelled) return
        const defaults = taskDefaultsFromSettings(settings)
        setFullParams(defaults.fullParams)
        setStandaloneParams(defaults.standaloneParams)
      })
      .catch(() => { /* 保留内置默认值 */ })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    localStorage.setItem(taskConfigKey, JSON.stringify({ fullParams, standaloneParams }))
  }, [fullParams, standaloneParams])
  useEffect(() => {
    return () => {
      if (closeRef.current) closeRef.current()
      if (progressTimerRef.current != null) window.clearTimeout(progressTimerRef.current)
      if (pollTimerRef.current != null) window.clearInterval(pollTimerRef.current)
    }
  }, [])

  const clearProgressTimer = () => {
    if (progressTimerRef.current != null) { window.clearTimeout(progressTimerRef.current); progressTimerRef.current = null }
    pendingProgressRef.current = null
  }
  const clearRunPoll = () => {
    if (pollTimerRef.current != null) { window.clearInterval(pollTimerRef.current); pollTimerRef.current = null }
  }

  const applyRunSnapshot = (run: TestRunEntity) => {
    const progress = run.progress ?? { runId: run.id, status: run.status, message: run.error || run.status }
    // Only update activeRun if user hasn't dismissed the modal
    if (!progressDismissedRef.current) setActiveRun(progress)
    if (terminalStatuses.has(run.status)) {
      clearProgressTimer(); clearRunPoll()
      if (closeRef.current) { closeRef.current(); closeRef.current = null }
      fetchRuns()
    }
  }

  const subscribeRun = (runId: string) => {
    if (closeRef.current) closeRef.current()
    clearProgressTimer(); clearRunPoll()
    setActiveRunId(runId)
    progressDismissedRef.current = false  // Reset dismiss flag for new subscription
    closeRef.current = api.runs.events(runId, (data) => {
      const progress = data as RunProgress
      if (terminalStatuses.has(progress.status)) {
        clearProgressTimer(); clearRunPoll()
        if (closeRef.current) { closeRef.current(); closeRef.current = null }
        if (!progressDismissedRef.current) setActiveRun(progress)
        fetchRuns()
        return
      }
      pendingProgressRef.current = progress
      if (progressTimerRef.current != null) return
      progressTimerRef.current = window.setTimeout(() => {
        if (pendingProgressRef.current && !progressDismissedRef.current) {
          setActiveRun(pendingProgressRef.current)
        }
        pendingProgressRef.current = null; progressTimerRef.current = null
      }, 150)
    })
    pollTimerRef.current = window.setInterval(async () => {
      try { applyRunSnapshot(await api.runs.get(runId)) } catch { /* */ }
    }, 3000)
  }

  // When user clicks "关闭" on progress modal, mark dismissed and hide
  const dismissProgress = () => {
    progressDismissedRef.current = true
    setActiveRun(null)
    setActiveRunId(null)
  }

  const startFull = async () => {
    try {
      const result = await api.runs.full({
        scope: 'all', dedupeMode: fullParams.dedupeMode as any,
        alive: { enabled: true, concurrency: fullParams.aliveConcurrency, timeoutMs: fullParams.aliveTimeoutMs },
        speed: { enabled: fullParams.speedEnabled, concurrency: fullParams.speedConcurrency, minMBps: fullParams.speedMinMBps, targetCount: fullParams.speedTargetCount, testUrl: fullParams.speedTestUrl, timeoutMs: fullParams.speedTimeoutMs },
        unlock: { enabled: fullParams.unlockEnabled, platforms: fullParams.unlockPlatforms, concurrency: fullParams.unlockConcurrency, timeoutMs: fullParams.unlockTimeoutMs },
        countryBackup: { enabled: fullParams.countryBackupEnabled, perCountry: fullParams.countryPerCountry }
      })
      subscribeRun(result.runId); fetchRuns()
    } catch (e) { alert(e instanceof Error ? e.message : '启动失败') }
  }

  const startAlone = async (type: string) => {
    try {
      let result: { runId: string }
      if (type === 'alive') result = await api.runs.alive({ concurrency: standaloneParams.aliveConcurrency, timeoutMs: standaloneParams.aliveTimeoutMs })
      else if (type === 'speed') result = await api.runs.speed({ concurrency: standaloneParams.speedConcurrency, minMBps: standaloneParams.speedMinMBps, targetCount: standaloneParams.speedTargetCount, testUrl: standaloneParams.speedTestUrl, timeoutMs: standaloneParams.speedTimeoutMs })
      else if (type === 'unlock') result = await api.runs.unlock({ platforms: standaloneParams.unlockPlatforms, concurrency: standaloneParams.unlockConcurrency, timeoutMs: standaloneParams.unlockTimeoutMs })
      else result = await api.runs.countryBackup({})
      subscribeRun(result.runId); fetchRuns()
    } catch (e) { alert(e instanceof Error ? e.message : '启动失败') }
  }

  const cancelRun = async (id: string) => {
    try {
      await api.runs.cancel(id)
      if (activeRunId === id) setActiveRun((prev) => prev ? { ...prev, status: 'cancelled', message: '正在取消任务' } : prev)
      if (detailRun?.id === id) setDetailRun(await api.runs.get(id))
      fetchRuns()
    } catch (e) { alert(e instanceof Error ? e.message : '取消失败') }
  }

  const pauseRun = async (id: string) => {
    try {
      await api.runs.pause(id)
      if (activeRunId === id) setActiveRun((prev) => prev ? { ...prev, status: 'paused', message: '任务已暂停' } : prev)
      if (detailRun?.id === id) setDetailRun(await api.runs.get(id))
      fetchRuns()
    } catch (e) { alert(e instanceof Error ? e.message : '暂停失败') }
  }

  const resumeRun = async (id: string) => {
    try {
      await api.runs.resume(id)
      if (activeRunId === id) setActiveRun((prev) => prev ? { ...prev, status: 'running', message: '任务继续' } : prev)
      if (detailRun?.id === id) setDetailRun(await api.runs.get(id))
      fetchRuns()
    } catch (e) { alert(e instanceof Error ? e.message : '继续失败') }
  }

  const clearHistory = async () => {
    if (!confirm('确定清除所有已结束的历史任务？正在运行和排队中的任务会保留。')) return
    try {
      const result = await api.runs.clearHistory()
      alert(`已清除 ${result.deleted} 条历史任务`)
      setDetailRun(null); await fetchRuns()
    } catch (e) { alert(e instanceof Error ? e.message : '清除历史任务失败') }
  }

  const showRunDetail = async (id: string) => {
    try { setDetailRun(await api.runs.get(id)) } catch (e) { alert(e instanceof Error ? e.message : '加载任务详情失败') }
  }

  return (
    <div>
      {/* Modals */}
      {activeRun && (
        <ProgressModal run={activeRun} onClose={dismissProgress} onPause={pauseRun} onResume={resumeRun} />
      )}
      {detailRun && <DetailModal run={detailRun} onClose={() => setDetailRun(null)} />}

      <div className="section-title">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
        任务中心
      </div>

      <div className="grid-2" style={{ marginBottom: 24 }}>
        <div className="card">
          <div className="card-header">全量任务</div>
          <div className="grid-2">
            <div className="form-group">
              <label>去重策略</label>
              <select value={fullParams.dedupeMode} onChange={(e) => setFullParams({ ...fullParams, dedupeMode: e.target.value })}>
                <option value="strict_uri">严格URI</option>
                <option value="normalized_config">标准化配置</option>
                <option value="endpoint">协议+IP+端口</option>
                <option value="exit_ip_after_alive">出口IP</option>
              </select>
            </div>
            <div className="form-group">
              <label>测活并发</label>
              <input type="number" value={fullParams.aliveConcurrency} onChange={(e) => setFullParams({ ...fullParams, aliveConcurrency: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>测活超时 ms</label>
              <input type="number" value={fullParams.aliveTimeoutMs} onChange={(e) => setFullParams({ ...fullParams, aliveTimeoutMs: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>测速并发</label>
              <input type="number" value={fullParams.speedConcurrency} onChange={(e) => setFullParams({ ...fullParams, speedConcurrency: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>测速超时 ms</label>
              <input type="number" value={fullParams.speedTimeoutMs} onChange={(e) => setFullParams({ ...fullParams, speedTimeoutMs: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>最低速度 MB/s</label>
              <input type="number" value={fullParams.speedMinMBps} onChange={(e) => setFullParams({ ...fullParams, speedMinMBps: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>目标数量</label>
              <input type="number" value={fullParams.speedTargetCount} onChange={(e) => setFullParams({ ...fullParams, speedTargetCount: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>解锁并发</label>
              <input type="number" value={fullParams.unlockConcurrency} onChange={(e) => setFullParams({ ...fullParams, unlockConcurrency: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>解锁超时 ms</label>
              <input type="number" value={fullParams.unlockTimeoutMs} onChange={(e) => setFullParams({ ...fullParams, unlockTimeoutMs: Number(e.target.value) })} />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <label><input type="checkbox" checked={fullParams.countryBackupEnabled} onChange={(e) => setFullParams({ ...fullParams, countryBackupEnabled: e.target.checked })} /> 国家备份</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              每国 <input type="number" min={1} max={20} value={fullParams.countryPerCountry} onChange={(e) => setFullParams({ ...fullParams, countryPerCountry: Number(e.target.value) })} style={{ width: 72 }} />
            </label>
            <span className="badge badge-dim">Telegram 通知按设置页任务项执行</span>
          </div>
          <button className="btn btn-primary" onClick={startFull}>启动全量任务</button>
        </div>

        <div className="card">
          <div className="card-header">单独任务</div>
          <div className="grid-2">
            <div className="form-group">
              <label>测活并发</label>
              <input type="number" value={standaloneParams.aliveConcurrency} onChange={(e) => setStandaloneParams({ ...standaloneParams, aliveConcurrency: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>测活超时 ms</label>
              <input type="number" value={standaloneParams.aliveTimeoutMs} onChange={(e) => setStandaloneParams({ ...standaloneParams, aliveTimeoutMs: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>测速并发</label>
              <input type="number" value={standaloneParams.speedConcurrency} onChange={(e) => setStandaloneParams({ ...standaloneParams, speedConcurrency: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>测速超时 ms</label>
              <input type="number" value={standaloneParams.speedTimeoutMs} onChange={(e) => setStandaloneParams({ ...standaloneParams, speedTimeoutMs: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>最低速度 MB/s</label>
              <input type="number" value={standaloneParams.speedMinMBps} onChange={(e) => setStandaloneParams({ ...standaloneParams, speedMinMBps: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>目标数量</label>
              <input type="number" value={standaloneParams.speedTargetCount} onChange={(e) => setStandaloneParams({ ...standaloneParams, speedTargetCount: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>解锁并发</label>
              <input type="number" value={standaloneParams.unlockConcurrency} onChange={(e) => setStandaloneParams({ ...standaloneParams, unlockConcurrency: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>解锁超时 ms</label>
              <input type="number" value={standaloneParams.unlockTimeoutMs} onChange={(e) => setStandaloneParams({ ...standaloneParams, unlockTimeoutMs: Number(e.target.value) })} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" onClick={() => startAlone('alive')}>测活</button>
            <button className="btn btn-primary btn-sm" onClick={() => startAlone('speed')}>测速</button>
            <button className="btn btn-primary btn-sm" onClick={() => startAlone('unlock')}>解锁检测</button>
            <button className="btn btn-ghost btn-sm" onClick={() => startAlone('backup')}>国家备份</button>
          </div>
        </div>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span>任务历史</span>
          <button className="btn btn-ghost btn-xs" onClick={clearHistory}>清除历史</button>
        </div>
        {runs.length === 0 ? (
          <div className="empty-state" style={{ padding: '32px 20px' }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .25 }}>
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span>暂无任务记录</span>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th><th>类型</th><th>状态</th><th>开始时间</th><th>结束时间</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td style={{ fontFamily: 'monospace', fontSize: '.85em' }}>{run.id.slice(0, 16)}...</td>
                  <td><span className="badge badge-dim">{typeLabel[run.type] || run.type}</span></td>
                  <td>
                    <span className={`badge ${statusBadge[run.status]}`}>{statusLabel[run.status]}</span>
                    {run.error && <span style={{ fontSize: '.8em', color: 'var(--c-danger)', marginLeft: 4 }} title={run.error}>⚠</span>}
                  </td>
                  <td style={{ fontSize: '.85em', color: 'var(--c-text-dim)' }}>{run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : '-'}</td>
                  <td style={{ fontSize: '.85em', color: 'var(--c-text-dim)' }}>{run.finishedAt ? new Date(run.finishedAt).toLocaleString('zh-CN') : '-'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-ghost btn-xs" onClick={() => showRunDetail(run.id)}>详情</button>
                      {!terminalStatuses.has(run.status) && (
                        <>
                          {(run.status === 'running' || run.status === 'paused') && (
                            <button className="btn btn-ghost btn-xs" onClick={() => subscribeRun(run.id)}>查看进度</button>
                          )}
                          {run.status === 'paused'
                            ? <button className="btn btn-primary btn-xs" onClick={() => resumeRun(run.id)}>继续</button>
                            : <button className="btn btn-ghost btn-xs" onClick={() => pauseRun(run.id)}>暂停</button>}
                          <button className="btn btn-ghost btn-xs" style={{ color: 'var(--c-danger)' }} onClick={() => cancelRun(run.id)}>取消</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={fetchRuns}>刷新</button>
      </div>
    </div>
  )
}
