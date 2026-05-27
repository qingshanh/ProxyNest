import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { AppSettings, ScheduledRunType } from '../types'

type ScheduleTaskForm = {
  id: string
  type: ScheduledRunType
  enabled: boolean
  cron: string
  notifyTelegram?: boolean
}

const defaultScheduleTasks: ScheduleTaskForm[] = [
  { id: 'full', type: 'full', enabled: false, cron: '0 4 * * *', notifyTelegram: true },
  { id: 'pool_alive', type: 'pool_alive', enabled: false, cron: '30 */6 * * *', notifyTelegram: false },
  { id: 'speed', type: 'speed', enabled: false, cron: '0 */8 * * *', notifyTelegram: false },
  { id: 'unlock', type: 'unlock', enabled: false, cron: '20 */8 * * *', notifyTelegram: false }
]

const scheduleTaskLabels: Record<ScheduledRunType, string> = {
  full: '全量测试', pool_alive: '优质池测活', speed: '测速', unlock: '解锁检测'
}

const dedupeDescriptions: Record<string, string> = {
  strict_uri: '完整 URI 或完整配置一致才算重复，最保守。',
  normalized_config: '忽略节点名称，按核心连接参数去重，适合保留同入口但认证或传输配置不同的节点。',
  endpoint: '同协议、同服务器地址、同端口即视为重复，去重力度更大，作为当前默认策略。',
  exit_ip_after_alive: '测活后按出口 IP 和国家辅助去重；入库前没有出口 IP 时先按入口地址兜底。'
}

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: string; text: string } | null>(null)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [changingPwd, setChangingPwd] = useState(false)

  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramChatId, setTelegramChatId] = useState('')
  const [telegramApiBaseUrl, setTelegramApiBaseUrl] = useState('https://api.telegram.org')
  const [telegramEnabled, setTelegramEnabled] = useState(false)
  const [testingTg, setTestingTg] = useState(false)

  const [aliveConcurrency, setAliveConcurrency] = useState(100)
  const [speedConcurrency, setSpeedConcurrency] = useState(8)
  const [unlockConcurrency, setUnlockConcurrency] = useState(40)

  const [dedupeMode, setDedupeMode] = useState('endpoint')
  const [autoDeleteFailedFetches, setAutoDeleteFailedFetches] = useState(3)
  const [aliveTimeoutMs, setAliveTimeoutMs] = useState(30000)
  const [speedTimeoutMs, setSpeedTimeoutMs] = useState(30000)
  const [unlockTimeoutMs, setUnlockTimeoutMs] = useState(30000)
  const [openaiUnlockUrl, setOpenaiUnlockUrl] = useState('https://chatgpt.com/')
  const [youtubeUnlockUrl, setYoutubeUnlockUrl] = useState('https://www.youtube.com/premium')
  const [netflixUnlockUrl, setNetflixUnlockUrl] = useState('https://www.netflix.com/title/80018499')
  const [disneyUnlockUrl, setDisneyUnlockUrl] = useState('https://www.disneyplus.com/')

  const [publicBaseUrl, setPublicBaseUrl] = useState('')
  const [runHistoryRetentionDays, setRunHistoryRetentionDays] = useState(30)
  const [scheduleTasks, setScheduleTasks] = useState<ScheduleTaskForm[]>(defaultScheduleTasks)
  const [geoipMode, setGeoipMode] = useState('local_with_api_fallback')
  const [geoipApiUrl, setGeoipApiUrl] = useState('')
  const [geoipDatabaseUrl, setGeoipDatabaseUrl] = useState('https://downloads.ip66.dev/db/ip66.mmdb')
  const [geoipAutoUpdate, setGeoipAutoUpdate] = useState(false)
  const [geoipUpdateCron, setGeoipUpdateCron] = useState('0 3 * * *')
  const [updatingGeoip, setUpdatingGeoip] = useState(false)

  const [poolAbsoluteMinSpeedMBps, setPoolAbsoluteMinSpeedMBps] = useState(1)
  const [poolMinSpeedMBps, setPoolMinSpeedMBps] = useState(3)
  const [poolMaxLatencyMs, setPoolMaxLatencyMs] = useState(800)
  const [poolAliveFailures, setPoolAliveFailures] = useState(3)
  const [poolSpeedFailures, setPoolSpeedFailures] = useState(3)
  const [poolLatencyFailures, setPoolLatencyFailures] = useState(3)

  const [githubToken, setGithubToken] = useState('')
  const [githubRawProxyPrefix, setGithubRawProxyPrefix] = useState('')
  const [githubApiBaseUrl, setGithubApiBaseUrl] = useState('https://api.github.com')
  const [ghDiscoveryEnabled, setGhDiscoveryEnabled] = useState(false)
  const [ghSearchDays, setGhSearchDays] = useState(7)
  const [ghMaxRepos, setGhMaxRepos] = useState(40)
  const [ghMaxCandidates, setGhMaxCandidates] = useState(120)
  const [ghMaxAdditions, setGhMaxAdditions] = useState(30)
  const [ghConcurrency, setGhConcurrency] = useState(12)
  const [ghValidateCandidates, setGhValidateCandidates] = useState(true)
  const [ghQueries, setGhQueries] = useState('')

  function mergeScheduleTasks(tasks: AppSettings['schedule']['tasks'] = []): ScheduleTaskForm[] {
    const byId = new Map(tasks.map((t) => [t.id, t]))
    return defaultScheduleTasks.map((t) => ({ ...t, ...byId.get(t.id) }))
  }

  const fetch = useCallback(async () => {
    try {
      const data = await api.settings.get()
      setSettings(data)
      setAliveConcurrency(data.concurrency.aliveRecommended)
      setSpeedConcurrency(data.concurrency.speedRecommended)
      setUnlockConcurrency(data.concurrency.unlockRecommended)
      setDedupeMode(data.dedupe.defaultMode)
      setAutoDeleteFailedFetches(data.subscriptions.autoDeleteFailedFetches)
      setAliveTimeoutMs(data.probeTimeouts.aliveMs)
      setSpeedTimeoutMs(data.probeTimeouts.speedMs)
      setUnlockTimeoutMs(data.probeTimeouts.unlockMs)
      setOpenaiUnlockUrl(data.unlockTest.openai)
      setYoutubeUnlockUrl(data.unlockTest.youtube)
      setNetflixUnlockUrl(data.unlockTest.netflix)
      setDisneyUnlockUrl(data.unlockTest.disney)
      setPublicBaseUrl(data.publicBaseUrl)
      setRunHistoryRetentionDays(data.schedule.runHistoryRetentionDays ?? 30)
      setScheduleTasks(mergeScheduleTasks(data.schedule.tasks))
      setGeoipMode(data.geoip.mode)
      setGeoipApiUrl(data.geoip.apiUrl)
      setGeoipDatabaseUrl(data.geoip.databaseUrl)
      setGeoipAutoUpdate(data.geoip.autoUpdate)
      setGeoipUpdateCron(data.geoip.updateCron)
      setPoolAbsoluteMinSpeedMBps(data.reusablePool.absoluteMinSpeedMBps)
      setPoolMinSpeedMBps(data.reusablePool.minSpeedMBps)
      setPoolMaxLatencyMs(data.reusablePool.maxLatencyMs)
      setPoolAliveFailures(data.reusablePool.removeAfterAliveFailures)
      setPoolSpeedFailures(data.reusablePool.removeAfterSpeedFailures)
      setPoolLatencyFailures(data.reusablePool.removeAfterLatencyFailures)
      setTelegramEnabled(data.telegram.enabled)
      setTelegramChatId(data.telegram.chatId)
      setTelegramApiBaseUrl(data.telegram.apiBaseUrl || 'https://api.telegram.org')
      setGithubRawProxyPrefix(data.github.rawProxyPrefix)
      setGithubApiBaseUrl(data.github.apiBaseUrl)
      setGhDiscoveryEnabled(data.github.discovery.enabled)
      setGhSearchDays(data.github.discovery.searchDays)
      setGhMaxRepos(data.github.discovery.maxRepos)
      setGhMaxCandidates(data.github.discovery.maxCandidates)
      setGhMaxAdditions(data.github.discovery.maxAdditions)
      setGhConcurrency(data.github.discovery.concurrency)
      setGhValidateCandidates(data.github.discovery.validateCandidates)
      setGhQueries(data.github.discovery.queries.join('\n'))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  const showMsg = (type: string, text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 3000)
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!oldPassword || newPassword.length < 6) { showMsg('error', '新密码至少 6 位'); return }
    setChangingPwd(true)
    try {
      await api.auth.changePassword(oldPassword, newPassword)
      setOldPassword(''); setNewPassword('')
      showMsg('success', '密码修改成功，请重新登录')
      setTimeout(() => { window.location.href = '/login' }, 1500)
    } catch (err) { showMsg('error', err instanceof Error ? err.message : '修改失败') }
    finally { setChangingPwd(false) }
  }

  const saveConcurrency = async () => {
    setSaving(true)
    try { await api.settings.patch({ concurrency: { aliveRecommended: aliveConcurrency, speedRecommended: speedConcurrency, unlockRecommended: unlockConcurrency } }); showMsg('success', '并发设置已保存') }
    catch (e) { showMsg('error', e instanceof Error ? e.message : '保存失败') }
    finally { setSaving(false) }
  }

  const saveDedupe = async () => {
    setSaving(true)
    try { await api.settings.patch({ dedupe: { defaultMode: dedupeMode }, subscriptions: { autoDeleteFailedFetches } }); showMsg('success', '已保存') }
    catch (e) { showMsg('error', e instanceof Error ? e.message : '保存失败') }
    finally { setSaving(false) }
  }

  const saveGeneral = async () => {
    setSaving(true)
    try { await api.settings.patch({ publicBaseUrl, probeTimeouts: { aliveMs: aliveTimeoutMs, speedMs: speedTimeoutMs, unlockMs: unlockTimeoutMs }, unlockTest: { openai: openaiUnlockUrl, youtube: youtubeUnlockUrl, netflix: netflixUnlockUrl, disney: disneyUnlockUrl }, schedule: { runHistoryRetentionDays, tasks: scheduleTasks }, geoip: { mode: geoipMode, apiUrl: geoipApiUrl, databaseUrl: geoipDatabaseUrl, autoUpdate: geoipAutoUpdate, updateCron: geoipUpdateCron } }); showMsg('success', '设置已保存') }
    catch (e) { showMsg('error', e instanceof Error ? e.message : '保存失败') }
    finally { setSaving(false) }
  }

  const saveReusablePool = async () => {
    setSaving(true)
    try { await api.settings.patch({ reusablePool: { absoluteMinSpeedMBps: poolAbsoluteMinSpeedMBps, minSpeedMBps: poolMinSpeedMBps, maxLatencyMs: poolMaxLatencyMs, removeAfterAliveFailures: poolAliveFailures, removeAfterSpeedFailures: poolSpeedFailures, removeAfterLatencyFailures: poolLatencyFailures } }); showMsg('success', '优质节点池规则已保存') }
    catch (e) { showMsg('error', e instanceof Error ? e.message : '保存失败') }
    finally { setSaving(false) }
  }

  const updateScheduleTask = (id: string, patch: Partial<ScheduleTaskForm>) => {
    setScheduleTasks((items) => items.map((i) => i.id === id ? { ...i, ...patch } : i))
  }

  const saveTelegram = async () => {
    setSaving(true)
    try { await api.settings.patch({ telegram: { enabled: telegramEnabled, botToken: telegramBotToken || undefined, chatId: telegramChatId, apiBaseUrl: telegramApiBaseUrl } }); showMsg('success', 'Telegram 设置已保存') }
    catch (e) { showMsg('error', e instanceof Error ? e.message : '保存失败') }
    finally { setSaving(false) }
  }

  const saveGithub = async () => {
    setSaving(true)
    try { await api.settings.patch({ github: { token: githubToken || undefined, rawProxyPrefix: githubRawProxyPrefix, apiBaseUrl: githubApiBaseUrl, discovery: { enabled: ghDiscoveryEnabled, searchDays: ghSearchDays, maxRepos: ghMaxRepos, maxCandidates: ghMaxCandidates, maxAdditions: ghMaxAdditions, concurrency: ghConcurrency, validateCandidates: ghValidateCandidates, queries: ghQueries.split('\n').map((q) => q.trim()).filter(Boolean) } } }); showMsg('success', 'GitHub 设置已保存') }
    catch (e) { showMsg('error', e instanceof Error ? e.message : '保存失败') }
    finally { setSaving(false) }
  }

  const testTelegram = async () => {
    setTestingTg(true)
    try { await api.settings.testTelegram(); showMsg('success', 'Telegram 测试通知已发送') }
    catch (e) { showMsg('error', e instanceof Error ? e.message : '发送失败') }
    finally { setTestingTg(false) }
  }

  const updateGeoip = async () => {
    setUpdatingGeoip(true)
    try {
      const result = await api.settings.updateGeoip()
      setSettings(result.settings)
      setGeoipDatabaseUrl(result.settings.geoip.databaseUrl)
      showMsg('success', `GeoIP 已更新 (${(result.bytes / 1024 / 1024).toFixed(1)} MB)`)
    } catch (e) { showMsg('error', e instanceof Error ? e.message : 'GeoIP 更新失败') }
    finally { setUpdatingGeoip(false) }
  }

  if (loading) return <div className="loading">加载中...</div>

  return (
    <div>
      {message && <div className={`toast toast-${message.type}`}>{message.text}</div>}
      <div className="section-title">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
        </svg>
        设置
      </div>

      <div style={{ display: 'grid', gap: 20, maxWidth: 900 }}>

        {/* Password */}
        <div className="card">
          <div className="card-header">修改密码</div>
          <form onSubmit={handleChangePassword}>
            <div className="form-row" style={{ alignItems: 'flex-end' }}>
              <div className="form-group">
                <label>旧密码</label>
                <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
              </div>
              <div className="form-group">
                <label>新密码 (至少6位)</label>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              </div>
              <button className="btn btn-primary" disabled={changingPwd} style={{ flexShrink: 0 }}>
                {changingPwd ? '修改中...' : '修改'}
              </button>
            </div>
          </form>
        </div>

        {/* Concurrency */}
        <div className="card">
          <div className="card-header">默认并发配置</div>
          <div className="form-row" style={{ alignItems: 'flex-end' }}>
            <div className="form-group">
              <label>测活并发 (推荐 300)</label>
              <input type="number" value={aliveConcurrency} onChange={(e) => setAliveConcurrency(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>测速并发 (推荐 8)</label>
              <input type="number" value={speedConcurrency} onChange={(e) => setSpeedConcurrency(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>解锁并发 (推荐 40)</label>
              <input type="number" value={unlockConcurrency} onChange={(e) => setUnlockConcurrency(Number(e.target.value))} />
            </div>
            <button className="btn btn-primary" onClick={saveConcurrency} disabled={saving} style={{ flexShrink: 0 }}>保存</button>
          </div>
        </div>

        {/* Dedupe & Auto-delete */}
        <div className="card">
          <div className="card-header">去重与自动清理</div>
          <div className="form-row" style={{ alignItems: 'flex-start' }}>
            <div className="form-group">
              <label>默认去重策略</label>
              <select value={dedupeMode} onChange={(e) => setDedupeMode(e.target.value)}>
                <option value="strict_uri">严格 URI</option>
                <option value="normalized_config">标准化配置</option>
                <option value="endpoint">协议+IP+端口</option>
                <option value="exit_ip_after_alive">出口 IP</option>
              </select>
              <div style={{ color: 'var(--c-text-dim)', fontSize: '.8em', marginTop: 6, lineHeight: 1.5 }}>
                {dedupeDescriptions[dedupeMode]}
              </div>
            </div>
            <div className="form-group">
              <label>连续失败自动删除阈值 (0=禁用)</label>
              <input type="number" value={autoDeleteFailedFetches} onChange={(e) => setAutoDeleteFailedFetches(Number(e.target.value))} />
            </div>
            <button className="btn btn-primary" onClick={saveDedupe} disabled={saving} style={{ flexShrink: 0, marginTop: 24 }}>保存</button>
          </div>
        </div>

        {/* Reusable pool */}
        <div className="card">
          <div className="card-header">优质节点池规则</div>
          <div className="grid-3" style={{ marginBottom: 14 }}>
            <div className="form-group">
              <label>入池硬性最低速度 MB/s</label>
              <input type="number" step="0.1" value={poolAbsoluteMinSpeedMBps} onChange={(e) => setPoolAbsoluteMinSpeedMBps(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>入池最低速度 MB/s</label>
              <input type="number" value={poolMinSpeedMBps} onChange={(e) => setPoolMinSpeedMBps(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>高延迟阈值 ms</label>
              <input type="number" value={poolMaxLatencyMs} onChange={(e) => setPoolMaxLatencyMs(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>连续综合不达标移除次数</label>
              <input type="number" value={poolAliveFailures} onChange={(e) => setPoolAliveFailures(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>测速不达标参考次数</label>
              <input type="number" value={poolSpeedFailures} onChange={(e) => setPoolSpeedFailures(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>高延迟参考次数</label>
              <input type="number" value={poolLatencyFailures} onChange={(e) => setPoolLatencyFailures(Number(e.target.value))} />
            </div>
          </div>
          <button className="btn btn-primary" onClick={saveReusablePool} disabled={saving}>保存</button>
        </div>

        {/* General */}
        <div className="card">
          <div className="card-header">通用设置</div>
          <div className="form-group">
            <label>公开域名 (publicBaseUrl)</label>
            <input type="text" value={publicBaseUrl} onChange={(e) => setPublicBaseUrl(e.target.value)} placeholder="https://example.com" />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: '.85em', fontWeight: 500, color: 'var(--c-text-dim)', display: 'block', marginBottom: 8 }}>各类测试超时 (ms)</label>
            <div className="grid-3">
              <div className="form-group">
                <label>测活超时</label>
                <input type="number" value={aliveTimeoutMs} onChange={(e) => setAliveTimeoutMs(Number(e.target.value))} />
              </div>
              <div className="form-group">
                <label>测速超时</label>
                <input type="number" value={speedTimeoutMs} onChange={(e) => setSpeedTimeoutMs(Number(e.target.value))} />
              </div>
              <div className="form-group">
                <label>解锁超时</label>
                <input type="number" value={unlockTimeoutMs} onChange={(e) => setUnlockTimeoutMs(Number(e.target.value))} />
              </div>
            </div>
            <div style={{ color: 'var(--c-text-dim)', fontSize: '.78em', marginTop: 4, lineHeight: 1.5 }}>
              默认统一为 30000 毫秒；任务中心和接口默认值都会读取这里。
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: '.85em', fontWeight: 500, color: 'var(--c-text-dim)', display: 'block', marginBottom: 8 }}>流媒体与解锁测试链接</label>
            <div className="grid-2">
              <div className="form-group">
                <label>OpenAI / ChatGPT</label>
                <input type="text" value={openaiUnlockUrl} onChange={(e) => setOpenaiUnlockUrl(e.target.value)} placeholder="https://chatgpt.com/" />
              </div>
              <div className="form-group">
                <label>YouTube</label>
                <input type="text" value={youtubeUnlockUrl} onChange={(e) => setYoutubeUnlockUrl(e.target.value)} placeholder="https://www.youtube.com/premium" />
              </div>
              <div className="form-group">
                <label>Netflix</label>
                <input type="text" value={netflixUnlockUrl} onChange={(e) => setNetflixUnlockUrl(e.target.value)} placeholder="https://www.netflix.com/title/80018499" />
              </div>
              <div className="form-group">
                <label>Disney+</label>
                <input type="text" value={disneyUnlockUrl} onChange={(e) => setDisneyUnlockUrl(e.target.value)} placeholder="https://www.disneyplus.com/" />
              </div>
            </div>
            <div style={{ color: 'var(--c-text-dim)', fontSize: '.78em', marginTop: 4, lineHeight: 1.5 }}>
              默认 OpenAI 已改为 `chatgpt.com` 首页，更接近真实访问；如果你有更稳的测试页，也可以在这里自行替换。
            </div>
          </div>
          {settings?.mihomo && (
            <div className={settings.mihomo.exists ? 'alert alert-success' : 'alert alert-error'}>
              Mihomo：{settings.mihomo.configured ? settings.mihomo.bin : '未配置 MIHOMO_BIN'}
              {settings.mihomo.configured ? (settings.mihomo.exists ? '，文件存在' : '，文件不存在') : ''}
            </div>
          )}
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: '.85em', fontWeight: 500, color: 'var(--c-text-dim)', display: 'block', marginBottom: 6 }}>定时任务</label>
            <div style={{ display: 'grid', gap: 8 }}>
              {scheduleTasks.map((task) => (
                <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
                    <input type="checkbox" checked={task.enabled} onChange={(e) => updateScheduleTask(task.id, { enabled: e.target.checked })} />
                    {scheduleTaskLabels[task.type]}
                  </label>
                  <input type="text" value={task.cron} onChange={(e) => updateScheduleTask(task.id, { cron: e.target.value })}
                         placeholder="0 4 * * *" style={{ width: 150 }} disabled={!task.enabled} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={Boolean(task.notifyTelegram)} onChange={(e) => updateScheduleTask(task.id, { notifyTelegram: e.target.checked })} />
                    Telegram
                  </label>
                </div>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label>历史任务保留天数 (0=不自动清理)</label>
            <input type="number" min={0} value={runHistoryRetentionDays} onChange={(e) => setRunHistoryRetentionDays(Math.max(0, Number(e.target.value)))} style={{ width: 160, display: 'block', marginTop: 5 }} />
          </div>
          <div className="form-row" style={{ alignItems: 'flex-start' }}>
            <div className="form-group">
              <label>GeoIP 模式</label>
              <select value={geoipMode} onChange={(e) => setGeoipMode(e.target.value)}>
                <option value="local_with_api_fallback">本地优先，在线兜底</option>
                <option value="local_only">仅本地</option>
                <option value="api_only">仅在线</option>
              </select>
            </div>
            <div className="form-group">
              <label>GeoIP API URL</label>
              <input type="text" value={geoipApiUrl} onChange={(e) => setGeoipApiUrl(e.target.value)} />
              <div style={{ color: 'var(--c-text-dim)', fontSize: '.78em', marginTop: 4, lineHeight: 1.5 }}>
                可留空使用默认 api；也可填 https://ipwho.is/{'{ip}'} 等。GitHub 目录或规则集链接无效。
              </div>
            </div>
          </div>
          <div className="form-row" style={{ alignItems: 'flex-start' }}>
            <div className="form-group">
              <label>GeoIP 本地库下载地址</label>
              <input type="text" value={geoipDatabaseUrl} onChange={(e) => setGeoipDatabaseUrl(e.target.value)} />
              <div style={{ color: 'var(--c-text-dim)', fontSize: '.78em', marginTop: 4, lineHeight: 1.5 }}>
                默认 ip66 日更 MMDB；也可换成 DB-IP Lite 或 IPinfo Lite 的 MMDB 地址。
              </div>
            </div>
            <div className="form-group">
              <label>本地库定时更新 cron</label>
              <input type="text" value={geoipUpdateCron} onChange={(e) => setGeoipUpdateCron(e.target.value)} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <input type="checkbox" checked={geoipAutoUpdate} onChange={(e) => setGeoipAutoUpdate(e.target.checked)} />
                自动更新
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" style={{ marginTop: 4 }} onClick={saveGeneral} disabled={saving}>保存</button>
            <button className="btn btn-ghost" style={{ marginTop: 4 }} onClick={updateGeoip} disabled={updatingGeoip}>
              {updatingGeoip ? '更新中...' : '立即更新 GeoIP 本地库'}
            </button>
            {settings?.geoip.lastUpdatedAt && <span className="badge badge-success">已更新 {new Date(settings.geoip.lastUpdatedAt).toLocaleString('zh-CN')}</span>}
            {settings?.geoip.lastUpdateError && <span className="badge badge-danger" title={settings.geoip.lastUpdateError}>更新失败</span>}
          </div>
        </div>

        {/* GitHub Discovery */}
        <div className="card">
          <div className="card-header">GitHub 订阅发现</div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={ghDiscoveryEnabled} onChange={(e) => setGhDiscoveryEnabled(e.target.checked)} />
              全量任务时自动搜索 GitHub 免费订阅
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={ghValidateCandidates} onChange={(e) => setGhValidateCandidates(e.target.checked)} />
              验证候选订阅
            </label>
          </div>
          <div className="form-group">
            <label>GitHub Token (可选，用于提高 API 限额)</label>
            <input type="password" value={githubToken} onChange={(e) => setGithubToken(e.target.value)}
                   placeholder={settings?.github.tokenSet ? '(已设置)' : 'ghp_xxx'} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>API 基础地址</label>
              <input type="text" value={githubApiBaseUrl} onChange={(e) => setGithubApiBaseUrl(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Raw 代理前缀</label>
              <input type="text" value={githubRawProxyPrefix} onChange={(e) => setGithubRawProxyPrefix(e.target.value)} placeholder="https://ghproxy.net/或留空" />
            </div>
          </div>
          <div className="grid-3" style={{ marginTop: 12, marginBottom: 14 }}>
            <div className="form-group">
              <label>搜索天数</label>
              <input type="number" value={ghSearchDays} onChange={(e) => setGhSearchDays(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>最大仓库数</label>
              <input type="number" value={ghMaxRepos} onChange={(e) => setGhMaxRepos(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>最大候选数</label>
              <input type="number" value={ghMaxCandidates} onChange={(e) => setGhMaxCandidates(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>最大添加数</label>
              <input type="number" value={ghMaxAdditions} onChange={(e) => setGhMaxAdditions(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>并发数</label>
              <input type="number" value={ghConcurrency} onChange={(e) => setGhConcurrency(Number(e.target.value))} />
            </div>
          </div>
          <div className="form-group">
            <label>搜索查询词 (每行一个)</label>
            <textarea value={ghQueries} onChange={(e) => setGhQueries(e.target.value)} rows={4}
                      placeholder="free clash subscription&#10;clash nodes&#10;免费 节点 订阅" />
          </div>
          <button className="btn btn-primary" onClick={saveGithub} disabled={saving}>保存 GitHub 设置</button>
        </div>

        {/* Telegram */}
        <div className="card">
          <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Telegram 通知</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, fontSize: '.9em' }}>
              <input type="checkbox" checked={telegramEnabled} onChange={(e) => setTelegramEnabled(e.target.checked)} /> 启用
            </label>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Bot Token</label>
              <input type="password" value={telegramBotToken} onChange={(e) => setTelegramBotToken(e.target.value)}
                     placeholder={settings?.telegram.botTokenSet ? '(已设置)' : '123456:token'} />
            </div>
            <div className="form-group">
              <label>Chat ID</label>
              <input type="text" value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} placeholder="123456" />
            </div>
            <div className="form-group">
              <label>API 反代地址</label>
              <input type="text" value={telegramApiBaseUrl} onChange={(e) => setTelegramApiBaseUrl(e.target.value)} placeholder="https://api.telegram.org" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn btn-primary" onClick={saveTelegram} disabled={saving}>保存</button>
            <button className="btn btn-ghost" onClick={testTelegram} disabled={testingTg}>
              {testingTg ? '发送中...' : '发送测试通知'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
