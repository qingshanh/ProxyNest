import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { DedupeMode, NodeEntity, ProxyProtocol, UnlockPlatform } from '../types'

export function NodesPage() {
  const [nodes, setNodes] = useState<NodeEntity[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [jumpPage, setJumpPage] = useState('1')
  const [pageSize] = useState(50)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({
    alive: '',
    protocol: '',
    country: '',
    unlock: '',
    minSpeedMBps: ''
  })
  const [dedupeMode, setDedupeMode] = useState<DedupeMode>('endpoint')
  const [message, setMessage] = useState<string | null>(null)
  const [sort, setSort] = useState('')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string | number> = { page, pageSize }
      if (filters.alive) params.alive = filters.alive
      if (filters.protocol) params.protocol = filters.protocol
      if (filters.country) params.country = filters.country
      if (filters.unlock) params.unlock = filters.unlock
      if (filters.minSpeedMBps) params.minSpeedMBps = Number(filters.minSpeedMBps)
      if (sort) { params.sort = sort; params.order = sortOrder }
      const result = await api.nodes.list(params)
      setNodes(result.items)
      setTotal(result.total)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, filters, sort, sortOrder])

  useEffect(() => {
    fetch()
  }, [fetch])

  useEffect(() => {
    setJumpPage(String(page))
  }, [page])

  const handleDelete = async (node: NodeEntity) => {
    if (!confirm(`确定删除节点 "${node.displayName}"？`)) return
    try {
      await api.nodes.delete(node.id)
      await fetch()
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败')
    }
  }

  const handleDedupe = async () => {
    if (!confirm(`确定使用 "${dedupeMode}" 策略去重？此操作不可撤销。`)) return
    try {
      const result = await api.nodes.dedupe(dedupeMode)
      alert(`去重完成：${result.before} → ${result.after}，移除 ${result.removed} 个`)
      await fetch()
    } catch (e) {
      alert(e instanceof Error ? e.message : '去重失败')
    }
  }

  const showMessage = (text: string) => {
    setMessage(text)
    setTimeout(() => setMessage(null), 2500)
  }

  const handleRecheck = async (node: NodeEntity) => {
    try {
      await api.nodes.recheck(node.id)
      showMessage('已提交单节点测活任务')
    } catch (e) {
      showMessage(e instanceof Error ? e.message : '测活任务提交失败')
    }
  }

  const handleSpeedtest = async (node: NodeEntity) => {
    try {
      await api.nodes.speedtest(node.id)
      showMessage('已提交单节点测速任务')
    } catch (e) {
      showMessage(e instanceof Error ? e.message : '测速任务提交失败')
    }
  }

  const totalPages = Math.ceil(total / pageSize)
  const goToPage = () => {
    const next = Math.min(Math.max(Number(jumpPage) || 1, 1), Math.max(totalPages, 1))
    setPage(next)
    setJumpPage(String(next))
  }

  const toggleSort = (col: string) => {
    if (sort === col) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSort(col)
      setSortOrder('desc')
    }
    setPage(1)
  }

  const sortArrow = (col: string) => {
    if (sort !== col) return <span style={{ opacity: .25, marginLeft: 2 }}>↕</span>
    return <span style={{ marginLeft: 2 }}>{sortOrder === 'asc' ? '↑' : '↓'}</span>
  }

  const handleExport = (format: string) => {
    const params: Record<string, string | number | undefined> = {}
    if (filters.alive) params.alive = filters.alive
    if (filters.protocol) params.protocol = filters.protocol
    if (filters.country) params.country = filters.country
    if (filters.unlock) params.unlock = filters.unlock
    if (filters.minSpeedMBps) params.minSpeedMBps = Number(filters.minSpeedMBps)
    const url = api.nodes.exportUrl(params, format)
    window.open(url, '_blank')
  }

  const protocols: ProxyProtocol[] = ['vmess', 'vless', 'trojan', 'ss', 'hysteria2', 'tuic']
  const unlockPlatforms: UnlockPlatform[] = ['openai', 'youtube', 'netflix', 'disney']
  const dedupeDescriptions: Record<DedupeMode, string> = {
    strict_uri: '严格匹配完整 URI 或完整配置，最保守，只有配置完全一致才会删重。',
    normalized_config: '忽略节点名称等展示字段，按协议、认证、传输参数等核心配置去重，适合保留同入口但认证或传输配置不同的节点。',
    endpoint: '只按协议、服务器地址和端口去重，力度更大，适合清掉同入口的重复节点，作为当前默认策略。',
    exit_ip_after_alive: '测活后优先按出口 IP 和国家去重；入库前没有出口 IP 时会先按入口地址兜底。'
  }

  return (
    <div>
      {message && <div className="toast toast-success">{message}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l-.06-.06a2 2 0 012.83 2.83l.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
          节点池 ({total} 个)
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={dedupeMode} onChange={(e) => setDedupeMode(e.target.value as DedupeMode)} style={{ fontSize: '.85em', padding: '4px 8px' }}>
            <option value="strict_uri">严格URI去重</option>
            <option value="normalized_config">标准化配置去重</option>
            <option value="endpoint">协议+IP+端口去重</option>
            <option value="exit_ip_after_alive">出口IP去重</option>
          </select>
          <button className="btn btn-danger btn-sm" onClick={handleDedupe}>执行去重</button>
        </div>
      </div>

      <div style={{ color: 'var(--c-text-dim)', fontSize: '.85em', marginBottom: 12 }}>
        {dedupeDescriptions[dedupeMode]}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-row">
          <div className="form-group">
            <label>存活状态</label>
            <select value={filters.alive} onChange={(e) => { setFilters({ ...filters, alive: e.target.value }); setPage(1) }}>
              <option value="">全部</option>
              <option value="true">存活</option>
              <option value="false">未存活</option>
            </select>
          </div>
          <div className="form-group">
            <label>协议</label>
            <select value={filters.protocol} onChange={(e) => { setFilters({ ...filters, protocol: e.target.value }); setPage(1) }}>
              <option value="">全部</option>
              {protocols.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>国家代码</label>
            <input
              value={filters.country}
              onChange={(e) => { setFilters({ ...filters, country: e.target.value }); setPage(1) }}
              placeholder="JP, US..."
              style={{ width: 100 }}
            />
          </div>
          <div className="form-group">
            <label>解锁平台</label>
            <select value={filters.unlock} onChange={(e) => { setFilters({ ...filters, unlock: e.target.value }); setPage(1) }}>
              <option value="">全部</option>
              {unlockPlatforms.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>最低速度 MB/s</label>
            <input
              type="number"
              value={filters.minSpeedMBps}
              onChange={(e) => { setFilters({ ...filters, minSpeedMBps: e.target.value }); setPage(1) }}
              placeholder="3"
              style={{ width: 80 }}
            />
          </div>
          <button className="btn btn-ghost btn-sm" onClick={fetch}>筛选</button>
          <button className="btn btn-ghost btn-sm" onClick={() => handleExport('clash')} title="导出 Clash YAML 订阅">导出 Clash</button>
          <button className="btn btn-ghost btn-sm" onClick={() => handleExport('v2ray')} title="导出 V2Ray Base64 订阅">导出 V2Ray</button>
        </div>
      </div>

      {loading ? (
        <div className="loading">加载中...</div>
      ) : nodes.length === 0 ? (
        <div className="card"><div className="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l-.06-.06a2 2 0 012.83 2.83l.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
          <span>暂无节点</span>
        </div></div>
      ) : (
        <>
          <div className="card" style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>协议</th>
                  <th>地址</th>
                  <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('alive')}>存活{sortArrow('alive')}</th>
                  <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('latency_ms')}>延迟{sortArrow('latency_ms')}</th>
                  <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('speed_bps')}>速度{sortArrow('speed_bps')}</th>
                  <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('country_code')}>国家{sortArrow('country_code')}</th>
                  <th>出口 IP</th>
                  <th>解锁</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.id}>
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={`原始: ${node.originalName}`}>
                      {node.displayName}
                    </td>
                    <td><span className="badge badge-info">{node.protocol}</span></td>
                    <td style={{ fontSize: '.85em' }}>{node.server}:{node.port}</td>
                    <td>
                      <span className={`badge ${node.alive ? 'badge-success' : 'badge-dim'}`}>
                        {node.alive ? '活' : '死'}
                      </span>
                    </td>
                    <td style={{ fontSize: '.85em' }}>
                      {node.latencyMs != null ? `${node.latencyMs}ms` : '-'}
                    </td>
                    <td style={{ fontSize: '.85em' }}>
                      {node.speedMBps != null ? `${node.speedMBps} MB/s` : '-'}
                    </td>
                    <td style={{ fontSize: '.85em' }}>
                      {node.countryName || node.countryCode || '-'}
                    </td>
                    <td style={{ fontSize: '.85em', color: 'var(--c-text-dim)' }}>
                      {node.exitIp || '-'}
                    </td>
                    <td style={{ fontSize: '.8em' }}>
                      {(['openai', 'youtube', 'netflix', 'disney'] as UnlockPlatform[]).map((p) => (
                        node.unlock[p]?.available ? (
                          <span key={p} className="badge badge-success" style={{ marginRight: 2 }} title={p}>
                            {p === 'openai' ? 'AI' : p === 'youtube' ? 'YT' : p === 'netflix' ? 'NF' : 'D+'}:{node.unlock[p]?.region || '✓'}
                          </span>
                        ) : null
                      ))}
                      {!Object.values(node.unlock).some((v) => v?.available) && '-'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-ghost btn-xs" onClick={() => handleRecheck(node)}>测活</button>
                        <button className="btn btn-ghost btn-xs" onClick={() => handleSpeedtest(node)}>测速</button>
                        <button className="btn btn-ghost btn-xs" style={{ color: 'var(--c-danger)' }}
                                onClick={() => handleDelete(node)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
              <span style={{ padding: '4px 12px', fontSize: '.9em', color: 'var(--c-text-dim)' }}>
                {page} / {totalPages}
              </span>
              <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
              <input
                type="number"
                min={1}
                max={totalPages}
                value={jumpPage}
                onChange={(e) => setJumpPage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') goToPage() }}
                style={{ width: 86, padding: '4px 8px', fontSize: '.85em' }}
              />
              <button className="btn btn-ghost btn-sm" onClick={goToPage}>跳页</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
