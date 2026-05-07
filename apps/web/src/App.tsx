import React, { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth'
import { Layout } from './Layout'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { SubscriptionsPage } from './pages/SubscriptionsPage'
import { NodesPage } from './pages/NodesPage'
import { TasksPage } from './pages/TasksPage'
import { ArtifactsPage } from './pages/ArtifactsPage'
import { ReusableNodesPage } from './pages/ReusableNodesPage'
import { SettingsPage } from './pages/SettingsPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="loading">加载中...</div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function GuestRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="loading">加载中...</div>
  if (user) return <Navigate to="/" replace />
  return <>{children}</>
}

function ThemeBoot() {
  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem('proxynest_theme') || localStorage.getItem('bestsub_theme') || 'light'
  }, [])
  return null
}

export function App() {
  return (
    <AuthProvider>
      <ThemeBoot />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<GuestRoute><LoginPage /></GuestRoute>} />
          <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route index element={<DashboardPage />} />
            <Route path="subscriptions" element={<SubscriptionsPage />} />
            <Route path="nodes" element={<NodesPage />} />
            <Route path="reusable-nodes" element={<ReusableNodesPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="artifacts" element={<ArtifactsPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
