import React, { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from './api'

type AuthState = {
  user: { id: string } | null
  loading: boolean
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
  error: string | null
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
  error: null
})

export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ id: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const check = useCallback(async () => {
    try {
      const data = await api.auth.me()
      setUser(data.user)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    check()
  }, [check])

  const login = useCallback(async (password: string) => {
    setError(null)
    try {
      const data = await api.auth.login(password)
      setUser(data.user)
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
      throw e
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.auth.logout()
    } catch { /* */ }
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, error }}>
      {children}
    </AuthContext.Provider>
  )
}
