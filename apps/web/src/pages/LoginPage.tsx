import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'

export function LoginPage() {
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const { login, error } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password) return
    setLoading(true)
    try {
      await login(password)
      navigate('/')
    } catch {
      // error is set by auth context
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh',
      background: 'var(--c-bg)', position: 'relative', overflow: 'hidden'
    }}>
      {/* Background decoration */}
      <div style={{
        position: 'absolute', top: '-20%', right: '-10%',
        width: '500px', height: '500px', borderRadius: '50%',
        background: 'radial-gradient(circle, var(--c-primary-light) 0%, transparent 70%)',
        pointerEvents: 'none'
      }} />
      <div style={{
        position: 'absolute', bottom: '-15%', left: '-5%',
        width: '400px', height: '400px', borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(16,185,129,.06) 0%, transparent 70%)',
        pointerEvents: 'none'
      }} />

      <div style={{
        width: '100%', maxWidth: 400, position: 'relative', zIndex: 1, padding: '0 16px'
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14, margin: '0 auto 16px',
            background: 'linear-gradient(135deg, var(--c-primary), var(--c-primary-hover))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 20px rgba(79,110,247,.35)'
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/>
              <path d="M2 17l10 5 10-5"/>
              <path d="M2 12l10 5 10-5"/>
            </svg>
          </div>
          <h1 style={{ fontSize: '1.6em', fontWeight: 700, marginBottom: 4 }}>ProxyNest</h1>
          <p style={{ color: 'var(--c-text-dim)', fontSize: '.9em' }}>订阅管理面板</p>
        </div>

        {/* Login card */}
        <div className="login-card" style={{
          background: 'var(--c-surface)', border: '1px solid var(--c-border)',
          borderRadius: 14, padding: '28px 32px', boxShadow: '0 10px 40px rgba(0,0,0,.06)'
        }}>
          <style>{`@media (max-width: 768px) { .login-card { padding: 20px 18px !important; } }`}</style>
          <form onSubmit={handleSubmit}>
            {error && (
              <div className="alert alert-error" style={{ marginBottom: 20 }}>{error}</div>
            )}
            <div className="form-group">
              <label>管理员密码</label>
              <div style={{ position: 'relative' }}>
                <svg
                  style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--c-text-dim)' }}
                  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0110 0v4"/>
                </svg>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                  autoFocus
                  style={{ width: '100%', paddingLeft: 38 }}
                />
              </div>
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
              style={{ width: '100%', justifyContent: 'center', padding: '12px', marginTop: 4 }}
            >
              {loading ? '登录中...' : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/>
                    <polyline points="10 17 15 12 10 7"/>
                    <line x1="15" y1="12" x2="3" y2="12"/>
                  </svg>
                  登录
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
