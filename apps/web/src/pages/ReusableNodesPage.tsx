import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { ReusableNodeEntity } from '../types'

export function ReusableNodesPage() {
  const [nodes, setNodes] = useState<ReusableNodeEntity[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [jumpPage, setJumpPage] = useState('1')
  const [pageSize] = useState(50)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({
    keepForReprobe: '',
    country: ''
  })
  const [message, setMessage] = useState<string | null>(null)
  const [sort, setSort] = useState('')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string | number> = { page, pageSize }
      if (filters.keepForReprobe) params.keepForReprobe = filters.keepForReprobe
      if (filters.country) params.country = filters.country
      if (sort) { params.sort = sort; params.order = sortOrder }
      const result = await api.reusableNodes.list(params)
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

  const handleToggle = async (node: ReusableNodeEntity) => {
    try {
      await api.reusableNodes.patch(node.poolId, !node.keepForReprobe)
      setMessage(node.keepForReprobe ? '已取消保留' : '已标记保留')
      setTimeout(() => setMessage(null), 2000)
      fetch()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '操作失败')
      setTimeout(() => setMessage(null), 3000)
    }
  }

  const handleDelete = async (node: ReusableNodeEntity) => {
    if (!confirm(`确定从优质池删除 "${node.displayName}"？`)) return
    try {
      await api.reusableNodes.delete(node.poolId)
      setMessage('已删除')
      setTimeout(() => setMessage(null), 2000)
      fetch()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '删除失败')
      setTimeout(() => setMessage(null), 3000)
    }
  }

  const handleRecheck = async (node: ReusableNodeEntity) => {
    try {
      await api.reusableNodes.recheck(node.poolId)
      setMessage('已发起重新检测')
      setTimeout(() => setMessage(null), 2000)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '检测失败')
      setTimeout(() => setMessage(null), 3000)
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
      setSortOrder(col === 'latency_ms' ? 'asc' : 'desc')
    }
    setPage(1)
  }

  const sortArrow = (col: string) => {
    if (sort !== col) return <span style={{ opacity: .25, marginLeft: 2 }}>↕</span>
    return <span style={{ marginLeft: 2 }}>{sortOrder === 'asc' ? '↑' : '↓'}</span>
  }

  const handleExport = (format: string) => {
    const params: Record<string, string | number | undefined> = {}
    if (filters.keepForReprobe) params.keepForReprobe = filters.keepForReprobe
    if (filters.country) params.country = filters.country
    const url = api.reusableNodes.exportUrl(params, format)
    window.open(url, '_blank')
  }

  const reasonBadge = (reason: string) => {
    const map: Record<string, { label: string; cls: string }> = {
      speed_10mbps_plus: { label: '>10MB/s', cls: 'badge-success' },
      speed_3mbps_plus: { label: '>3MB/s', cls: 'badge-success' },
      low_latency: { label: '低延迟', cls: 'badge-info' },
      unlock_openai: { label: 'AI', cls: 'badge-info' },
      unlock_youtube: { label: 'YT', cls: 'badge-info' },
      unlock_netflix: { label: 'NF', cls: 'badge-info' },
      unlock_disney: { label: 'DN', cls: 'badge-info' },
      unlock_success: { label: '解锁', cls: 'badge-info' },
      alive_recheck: { label: '存活', cls: 'badge-dim' },
      history_recheck: { label: '历史', cls: 'badge-dim' },
      manual_pin: { label: '手动', cls: 'badge-info' },
      manual_unpin: { label: '已取消', cls: 'badge-dim' },
      temporary_recheck: { label: '临时', cls: 'badge-dim' }
    }
    const c = map[reason]
    if (!c) return null
    return <span key={reason} className={`badge ${c.cls}`}>{c.label}</span>
  }

  return (
    <div>
      {message && <div className="toast toast-success">{message}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          优质节点池 ({total} 个)
        </div>
        <button className="btn btn-ghost btn-sm" onClick={fetch}>刷新</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-row">
          <div className="form-group">
            <label>保留状态</label>
            <select value={filters.keepForReprobe} onChange={(e) => { setFilters({ ...filters, keepForReprobe: e.target.value }); setPage(1) }}>
              <option value="">全部</option>
              <option value="true">已保留</option>
              <option value="false">未保留</option>
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
          <button className="btn btn-ghost btn-sm" onClick={fetch}>筛选</button>
          <button className="btn btn-ghost btn-sm" onClick={() => handleExport('clash')} title="导出 Clash YAML 订阅">导出 Clash</button>
          <button className="btn btn-ghost btn-sm" onClick={() => handleExport('v2ray')} title="导出 V2Ray Base64 订阅">导出 V2Ray</button>
        </div>
      </div>

      {loading ? (
        <div className="loading">加载中...</div>
      ) : nodes.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            <span>暂无优质节点，运行测活任务后自动发现</span>
          </div>
        </div>
      ) : (
        <>
          <div className="card" style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>协议</th>
                  <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('quality_score')}>质量分{sortArrow('quality_score')}</th>
                  <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('alive')}>存活{sortArrow('alive')}</th>
                  <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('latency_ms')}>延迟{sortArrow('latency_ms')}</th>
                  <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('speed_bps')}>速度{sortArrow('speed_bps')}</th>
                  <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('country_code')}>国家{sortArrow('country_code')}</th>
                  <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('success_streak')}>成功{sortArrow('success_streak')}<span style={{ opacity: .5 }}>/失败</span></th>
                  <th>保留</th>
                  <th>原因</th>
                  <th>下次复检</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.poolId}>
                    <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={`原始: ${node.originalName}`}>
                      {node.displayName}
                    </td>
                    <td><span className="badge badge-info">{node.protocol}</span></td>
                    <td>
                      <span className={`badge ${node.qualityScore >= 700 ? 'badge-success' : node.qualityScore >= 400 ? 'badge-warning' : 'badge-dim'}`}>
                        {node.qualityScore}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${node.alive ? 'badge-success' : 'badge-dim'}`}>
                        {node.alive ? '活' : '死'}
                      </span>
                    </td>
                    <td style={{ fontSize: '.85em' }}>{node.latencyMs != null ? `${node.latencyMs}ms` : '-'}</td>
                    <td style={{ fontSize: '.85em' }}>{node.speedMBps != null ? `${node.speedMBps} MB/s` : '-'}</td>
                    <td style={{ fontSize: '.85em' }}>{node.countryName || node.countryCode || '-'}</td>
                    <td style={{ fontSize: '.85em' }}>
                      <span style={{ color: 'var(--c-success)' }}>{node.successStreak}</span>
                      {' / '}
                      <span style={{ color: 'var(--c-danger)' }}>{node.failStreak}</span>
                    </td>
                    <td>
                      <span className={`badge ${node.keepForReprobe ? 'badge-success' : 'badge-dim'}`}>
                        {node.keepForReprobe ? '是' : '否'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {node.poolReason
                          ? node.poolReason.split('|').map(reasonBadge)
                          : <span style={{ color: 'var(--c-text-dim)', fontSize: '.85em' }}>-</span>}
                      </div>
                    </td>
                    <td style={{ fontSize: '.8em', color: 'var(--c-text-dim)' }}>
                      {node.nextRecheckAt ? new Date(node.nextRecheckAt).toLocaleString('zh-CN') : '-'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-ghost btn-xs" onClick={() => handleToggle(node)}>
                          {node.keepForReprobe ? '取消保留' : '保留'}
                        </button>
                        <button className="btn btn-ghost btn-xs" onClick={() => handleRecheck(node)}>
                          复检
                        </button>
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
