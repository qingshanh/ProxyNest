import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { DedupeMode, GithubDiscoveryResult, SourceEntity } from '../types'

export function SubscriptionsPage() {
  const [sources, setSources] = useState<SourceEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [batchText, setBatchText] = useState('')
  const [dedupeMode, setDedupeMode] = useState<DedupeMode>('endpoint')
  const [adding, setAdding] = useState(false)
  const [addResult, setAddResult] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discoverResult, setDiscoverResult] = useState<GithubDiscoveryResult | null>(null)
  const [copiedSourceId, setCopiedSourceId] = useState<string | null>(null)

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.subscriptions.list()
      setSources(data.items)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetch()
  }, [fetch])

  const handleBatchAdd = async () => {
    const lines = batchText.trim().split('\n').filter(Boolean)
    if (!lines.length) return
    const items = lines.map((line) => {
      const trimmed = line.trim()
      const lastSpace = trimmed.lastIndexOf(' ')
      if (lastSpace > 0) {
        const maybeUrl = trimmed.slice(lastSpace + 1)
        if (maybeUrl.startsWith('http://') || maybeUrl.startsWith('https://')) {
          return { name: trimmed.slice(0, lastSpace).trim(), url: maybeUrl }
        }
      }
      return { url: trimmed }
    })
    setAdding(true)
    setAddResult(null)
    try {
      const result = await api.subscriptions.batch(items, dedupeMode)
      setAddResult(
        `成功 ${result.created} 个，去重后节点 ${result.stats.uniqueNodes} 个` +
        (result.failed.length ? `\n失败: ${result.failed.map((f) => f.url + ': ' + f.error).join(', ')}` : '')
      )
      setBatchText('')
      await fetch()
    } catch (e) {
      setAddResult(e instanceof Error ? e.message : '添加失败')
    } finally {
      setAdding(false)
    }
  }

  const handleDiscover = async () => {
    if (!confirm('将在 GitHub 搜索免费订阅源，可能需要几分钟，确定继续？')) return
    setDiscovering(true)
    setDiscoverResult(null)
    try {
      const result = await api.subscriptions.discoverGithub()
      setDiscoverResult(result)
      await fetch()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'GitHub 发现失败')
    } finally {
      setDiscovering(false)
    }
  }

  const handleRefresh = async (id: string) => {
    try {
      await api.subscriptions.refresh(id)
      await fetch()
    } catch (e) {
      alert(e instanceof Error ? e.message : '刷新失败')
    }
  }

  const handleRefreshAll = async () => {
    setRefreshing(true)
    try {
      const result = await api.subscriptions.refreshAll()
      alert(
        `刷新完成：成功 ${result.refreshed}，失败 ${result.failed}` +
        (result.deleted ? `，自动删除 ${result.deleted}` : '') +
        (result.sourceDedupe.removed ? `，订阅去重 ${result.sourceDedupe.removed}` : '') +
        (result.dedupe.removed ? `，去重 ${result.dedupe.removed}` : '')
      )
      await fetch()
    } catch (e) {
      alert(e instanceof Error ? e.message : '刷新失败')
    } finally {
      setRefreshing(false)
    }
  }

  const handleToggle = async (source: SourceEntity) => {
    try {
      await api.subscriptions.update(source.id, { enabled: !source.enabled })
      await fetch()
    } catch (e) {
      alert(e instanceof Error ? e.message : '操作失败')
    }
  }

  const handleSetFailureThreshold = async (source: SourceEntity) => {
    const current = source.autoDeleteFailedFetches == null ? '' : String(source.autoDeleteFailedFetches)
    const value = prompt(
      '设置该订阅连续失败自动删除阈值。留空使用全局设置，0 表示禁用自动删除。',
      current
    )
    if (value == null) return
    const trimmed = value.trim()
    const next = trimmed === '' ? null : Number(trimmed)
    if (next != null && (!Number.isInteger(next) || next < 0)) {
      alert('请输入 0 或正整数；留空表示使用全局设置')
      return
    }
    try {
      await api.subscriptions.update(source.id, { autoDeleteFailedFetches: next })
      await fetch()
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败')
    }
  }

  const handleDelete = async (source: SourceEntity) => {
    if (!confirm(`确定删除订阅 "${source.name || source.url}"？`)) return
    try {
      await api.subscriptions.delete(source.id)
      await fetch()
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败')
    }
  }

  const copyBySelection = (text: string) => {
    const input = document.createElement('textarea')
    input.value = text
    input.setAttribute('readonly', 'true')
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.appendChild(input)
    input.select()
    input.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(input)
    return ok
  }

  const handleCopyUrl = async (source: SourceEntity) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(source.url)
      } else if (!copyBySelection(source.url)) {
        throw new Error('copy failed')
      }
      setCopiedSourceId(source.id)
      setTimeout(() => setCopiedSourceId(null), 1600)
    } catch {
      if (copyBySelection(source.url)) {
        setCopiedSourceId(source.id)
        setTimeout(() => setCopiedSourceId(null), 1600)
      }
    }
  }

  const dedupeLabels: Record<DedupeMode, string> = {
    strict_uri: '严格 URI',
    normalized_config: '标准化配置',
    endpoint: '协议+IP+端口',
    exit_ip_after_alive: '出口 IP（测活后）'
  }
  const dedupeDescriptions: Record<DedupeMode, string> = {
    strict_uri: '完整 URI 或完整配置一致才算重复，最保守。',
    normalized_config: '忽略节点名称，按核心连接参数去重，适合保留同入口但认证或传输配置不同的节点。',
    endpoint: '同协议、同服务器地址、同端口即视为重复，去重力度更大，作为当前默认策略。',
    exit_ip_after_alive: '测活后按出口 IP 和国家辅助去重；入库前没有出口 IP 时先按入口地址兜底。'
  }

  if (loading) return <div className="loading">加载中...</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
            <line x1="3" y1="6" x2="21" y2="6"/>
            <path d="M16 10a4 4 0 01-8 0"/>
          </svg>
          订阅管理
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={handleDiscover} disabled={discovering}>
            {discovering ? '搜索中...' : 'GitHub 发现'}
          </button>
          <button className="btn btn-ghost" onClick={handleRefreshAll} disabled={refreshing}>
            {refreshing ? '刷新中...' : '全部刷新'}
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd(!showAdd)}>
            {showAdd ? '取消' : '添加订阅'}
          </button>
        </div>
      </div>

      {discoverResult && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'var(--c-success)' }}>
          <div className="card-header">GitHub 发现结果</div>
          <div className="grid-3" style={{ fontSize: '.9em' }}>
            <div>搜索仓库: <strong>{discoverResult.searchedRepos}</strong></div>
            <div>候选 URL: <strong>{discoverResult.candidateUrls}</strong></div>
            <div>验证通过: <strong>{discoverResult.validUrls}</strong></div>
            <div>成功添加: <strong style={{ color: 'var(--c-success)' }}>{discoverResult.added}</strong></div>
            <div>跳过已存在: <strong>{discoverResult.skippedExisting}</strong></div>
            <div>失败: <strong style={{ color: 'var(--c-danger)' }}>{discoverResult.failed.length}</strong></div>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }}
                  onClick={() => setDiscoverResult(null)}>关闭</button>
        </div>
      )}

      {showAdd && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">批量添加订阅</div>
          <div style={{ color: 'var(--c-text-dim)', fontSize: '.85em', marginBottom: 12 }}>
            每行一个 URL，格式：<code>订阅名称 https://example.com/sub</code>（名称可选，用空格分隔）
          </div>
          <div className="form-group">
            <textarea
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              placeholder={`机场A https://example1.com/sub\nhttps://example2.com/sub\n机场B https://example3.com/sub`}
              rows={5}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>去重策略</label>
              <select value={dedupeMode} onChange={(e) => setDedupeMode(e.target.value as DedupeMode)}>
                {Object.entries(dedupeLabels).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <div style={{ color: 'var(--c-text-dim)', fontSize: '.8em', marginTop: 6 }}>
                {dedupeDescriptions[dedupeMode]}
              </div>
            </div>
            <button className="btn btn-primary" onClick={handleBatchAdd} disabled={adding || !batchText.trim()}>
              {adding ? '添加中...' : '添加'}
            </button>
          </div>
          {addResult && (
            <div className={`alert ${addResult.includes('失败') ? 'alert-error' : 'alert-success'}`} style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
              {addResult}
            </div>
          )}
        </div>
      )}

      {sources.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
              <line x1="3" y1="6" x2="21" y2="6"/>
              <path d="M16 10a4 4 0 01-8 0"/>
            </svg>
            <span>暂无订阅，点击"添加订阅"或"GitHub 发现"开始</span>
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>URL</th>
                <th>来源</th>
                <th>状态</th>
                <th>失败次数</th>
                <th>删除阈值</th>
                <th>节点数</th>
                <th>协议分布</th>
                <th>最后成功</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}
                    style={!source.valid && source.failedFetchCount >= 2 ? { opacity: .5 } : undefined}>
                  <td style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {source.name || '-'}
                  </td>
                  <td style={{ maxWidth: 260 }} title={source.url}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => handleCopyUrl(source)}
                        title="copy URL"
                      >
                        copy
                      </button>
                      {copiedSourceId === source.id && (
                        <span className="badge badge-success">copied</span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleCopyUrl(source)}
                        style={{
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          background: 'transparent',
                          border: 0,
                          color: 'var(--c-text)',
                          padding: 0,
                          cursor: 'copy',
                          textAlign: 'left'
                        }}
                      >
                        {source.url}
                      </button>
                    </div>
                  </td>
                  <td>
                    {source.discoveredBy ? (
                      <span className="badge badge-info">{source.discoveredBy}</span>
                    ) : (
                      <span className="badge badge-dim">手动</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${source.valid ? 'badge-success' : 'badge-danger'}`}>
                      {source.valid ? '有效' : '无效'}
                    </span>
                    {source.lastError && (
                      <span style={{ fontSize: '.8em', color: 'var(--c-danger)', marginLeft: 4 }} title={source.lastError}>
                        ⚠
                      </span>
                    )}
                  </td>
                  <td>
                    {source.failedFetchCount > 0 ? (
                      <span className={`badge ${source.failedFetchCount >= 2 ? 'badge-danger' : 'badge-warning'}`}>
                        {source.failedFetchCount}
                      </span>
                    ) : '-'}
                  </td>
                  <td style={{ fontSize: '.85em' }}>
                    {source.autoDeleteFailedFetches == null
                      ? <span className="badge badge-dim">全局</span>
                      : <span className="badge badge-info">{source.autoDeleteFailedFetches}</span>}
                  </td>
                  <td>{source.nodeCount}</td>
                  <td style={{ fontSize: '.85em' }}>
                    {Object.entries(source.typeSummary).map(([k, v]) => (
                      <span key={k} className="badge badge-dim" style={{ marginRight: 4 }}>{k}: {v}</span>
                    ))}
                    {!Object.keys(source.typeSummary).length && '-'}
                  </td>
                  <td style={{ fontSize: '.85em', color: 'var(--c-text-dim)' }}>
                    {source.lastSuccessAt ? new Date(source.lastSuccessAt).toLocaleString('zh-CN') : '-'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-ghost btn-xs" onClick={() => handleRefresh(source.id)}>刷新</button>
                      <button className="btn btn-ghost btn-xs" onClick={() => handleSetFailureThreshold(source)}>阈值</button>
                      <button className="btn btn-ghost btn-xs" onClick={() => handleToggle(source)}>
                        {source.enabled ? '禁用' : '启用'}
                      </button>
                      <button className="btn btn-ghost btn-xs" style={{ color: 'var(--c-danger)' }} onClick={() => handleDelete(source)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
