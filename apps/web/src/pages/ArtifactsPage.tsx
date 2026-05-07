import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { ArtifactEntity } from '../types'

export function ArtifactsPage() {
  const [artifacts, setArtifacts] = useState<ArtifactEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.artifacts.list()
      setArtifacts(data.items)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetch()
  }, [fetch])

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

  const writeClipboard = async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else if (!copyBySelection(text)) {
        throw new Error('copy failed')
      }
    } catch {
      copyBySelection(text)
    }
  }

  const flashCopied = (key: string, message = 'copied') => {
    setCopiedKey(key)
    setToast(message)
    setTimeout(() => {
      setToast(null)
      setCopiedKey(null)
    }, 1600)
  }

  const copyText = async (artifact: ArtifactEntity) => {
    await writeClipboard(artifact.url)
    flashCopied(artifact.key)
  }

  const copyAll = async () => {
    const urls = artifacts.map((artifact) => artifact.url).filter(Boolean)
    if (!urls.length) return
    await writeClipboard(urls.join('\n'))
    flashCopied('__all__', `已复制 ${urls.length} 条订阅`)
  }

  const handleRegenerateToken = async () => {
    if (!confirm('确定重置订阅 Token？旧的订阅链接将立即失效。')) return
    try {
      const data = await api.settings.regenerateSubToken()
      setArtifacts(data.items)
      setToast('Token 已重置')
      setTimeout(() => setToast(null), 2000)
    } catch (e) {
      alert(e instanceof Error ? e.message : '重置失败')
    }
  }

  const formatLabel = (f: 'clash' | 'v2ray') => f === 'clash' ? 'Clash/Mihomo' : 'v2rayN/NG'

  if (loading) return <div className="loading">加载中...</div>

  return (
    <div>
      {toast && <div className="toast toast-success">{toast}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          订阅
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {artifacts.length > 0 && (
            <button className="btn btn-primary btn-sm" onClick={copyAll}>
              复制全部订阅
              {copiedKey === '__all__' && <span style={{ marginLeft: 6 }}>copied</span>}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={fetch}>刷新</button>
          <button className="btn btn-danger btn-sm" onClick={handleRegenerateToken}>重置订阅 Token</button>
        </div>
      </div>

      {artifacts.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>暂无订阅，请先运行任务生成订阅</span>
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>标题</th>
                <th>格式</th>
                <th>节点数</th>
                <th>更新时间</th>
                <th>地址</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {artifacts.map((artifact) => (
                <tr key={artifact.key}>
                  <td style={{ fontWeight: 500 }}>{artifact.title}</td>
                  <td><span className="badge badge-info">{formatLabel(artifact.format)}</span></td>
                  <td>{artifact.nodeCount}</td>
                  <td style={{ fontSize: '.85em', color: 'var(--c-text-dim)' }}>
                    {new Date(artifact.updatedAt).toLocaleString('zh-CN')}
                  </td>
                  <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <a href={artifact.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '.85em' }}>
                      {artifact.url}
                    </a>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <button className="btn btn-primary btn-xs" onClick={() => copyText(artifact)}>复制</button>
                      {copiedKey === artifact.key && <span className="badge badge-success">copied</span>}
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
