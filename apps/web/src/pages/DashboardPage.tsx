import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { DashboardSummary } from '../types'

const statIcon = (i: number) => {
  const icons = [
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>,
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1010 10"/><path d="M12 6v6l4 2"/></svg>
  ]
  return icons[i] || icons[0]
}

const statColors = [
  'var(--c-primary)',
  'var(--c-info)',
  'var(--c-success)',
  'var(--c-info)',
  '#a855f7',
  '#f59e0b'
]

export function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      setSummary(await api.dashboard.summary())
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch() }, [fetch])

  if (loading) return <div className="loading">加载中...</div>
  if (!summary) return <div className="alert alert-error">加载失败</div>

  const statCards = [
    { label: '订阅源', value: summary.subscriptions, link: '/subscriptions' },
    { label: '总节点', value: summary.totalNodes },
    { label: '活节点', value: summary.aliveNodes, highlight: true },
    { label: '测速合格', value: summary.speedNodes, highlight: true },
    { label: '优质节点池', value: summary.reusableNodes, link: '/reusable-nodes' },
    { label: '国家数量', value: summary.countries },
  ]

  const statusLabel: Record<string, string> = {
    queued: '排队中', running: '运行中', success: '成功', failed: '失败', cancelled: '已取消'
  }
  const statusBadge: Record<string, string> = {
    queued: 'badge-warning', running: 'badge-info', success: 'badge-success', failed: 'badge-danger', cancelled: 'badge-dim'
  }
  const typeLabel: Record<string, string> = {
    full: '全量', alive: '测活', speed: '测速', unlock: '解锁', country_backup: '国家备份', fetch: '拉取'
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          仪表盘
        </div>
        <button className="btn btn-ghost btn-sm" onClick={fetch}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
          </svg>
          刷新
        </button>
      </div>

      <div className="grid-3" style={{ marginBottom: 28 }}>
        {statCards.map((card, i) => (
          <div className="stat-card" key={card.label}>
            <div className="stat-icon" style={{ color: statColors[i] }}>{statIcon(i)}</div>
            <div className="stat-value" style={{
              ...(card.highlight ? { color: 'var(--c-success)' } : { color: statColors[i] })
            }}>
              {card.value}
            </div>
            <div className="stat-label">
              {card.link ? (
                <Link to={card.link} style={{ fontWeight: 500 }}>
                  {card.label}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4, verticalAlign: 'middle' }}>
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                  </svg>
                </Link>
              ) : card.label}
            </div>
            {/* Color top border */}
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 3,
              background: card.highlight ? 'var(--c-success)' : statColors[i],
              borderTopLeftRadius: 'var(--radius-lg)', borderTopRightRadius: 'var(--radius-lg)'
            }} />
          </div>
        ))}
      </div>

      {summary.lastRun ? (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            最近任务
          </div>
          <div style={{ display: 'flex', gap: 32, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <span style={{ color: 'var(--c-text-dim)', fontSize: '.85em' }}>类型：</span>
              <span className="badge badge-info" style={{ marginLeft: 4 }}>{typeLabel[summary.lastRun.type] || summary.lastRun.type}</span>
            </div>
            <div>
              <span style={{ color: 'var(--c-text-dim)', fontSize: '.85em' }}>状态：</span>
              <span className={`badge ${statusBadge[summary.lastRun.status] || 'badge-dim'}`}>
                {statusLabel[summary.lastRun.status] || summary.lastRun.status}
              </span>
            </div>
            {summary.lastRun.finishedAt && (
              <div>
                <span style={{ color: 'var(--c-text-dim)', fontSize: '.85em' }}>完成时间：</span>
                <span style={{ fontSize: '.9em' }}>{new Date(summary.lastRun.finishedAt).toLocaleString('zh-CN')}</span>
              </div>
            )}
          </div>
          <div style={{ marginTop: 14 }}>
            <Link to="/tasks" className="btn btn-ghost btn-sm">
              查看全部任务
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </Link>
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="empty-state" style={{ padding: '32px 20px' }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .25 }}>
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span>暂无任务记录，前往 <Link to="/tasks">任务中心</Link> 启动任务</span>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12 }}>
        <Link to="/tasks" className="btn btn-primary">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          启动任务
        </Link>
        <Link to="/artifacts" className="btn btn-ghost">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          查看订阅
        </Link>
      </div>
    </div>
  )
}
