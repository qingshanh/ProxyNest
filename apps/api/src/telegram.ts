import type { Store } from './store'
import type { ArtifactEntity, TestRunEntity } from './types'

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export class TelegramService {
  constructor(private readonly store: Store) {}

  async sendTest(): Promise<void> {
    const settings = this.store.getSettings()
    if (!settings.telegram.enabled) throw new Error('Telegram 未启用')
    await this.sendHtml([
      '✨ <b>ProxyNest 通知测试</b>',
      '',
      '✅ <b>状态</b>：配置可用',
      `🕒 <b>时间</b>：${escapeHtml(this.formatDate(new Date().toISOString()))}`
    ].join('\n'))
  }

  async sendRunSummary(runId: string): Promise<{ sent: boolean; skippedReason?: string }> {
    const settings = this.store.getSettings()
    if (!settings.telegram.enabled) return { sent: false, skippedReason: 'Telegram 未启用' }
    if (!settings.telegram.botToken || !settings.telegram.chatId) {
      return { sent: false, skippedReason: 'Telegram Bot Token 或 Chat ID 未配置' }
    }
    const summary = this.store.dashboardSummary()
    const artifacts = this.store.listArtifacts()
    const run = this.store.getRun(runId)
    const lines = [
      '✨ <b>ProxyNest 订阅更新通知</b>',
      '',
      `🟢 <b>任务状态</b>：${escapeHtml(this.runTitle(run))} 已完成`,
      `🆔 <b>任务 ID</b>：<code>${escapeHtml(runId.slice(0, 16))}</code>`,
      `🕒 <b>更新时间</b>：${escapeHtml(this.formatDate(run?.finishedAt ?? new Date().toISOString()))}`,
      '',
      '📊 <b>节点概览</b>',
      `├ 订阅源：<b>${this.num(summary.subscriptions)}</b>`,
      `├ 总节点：<b>${this.num(summary.totalNodes)}</b> / 去重后：<b>${this.num(summary.uniqueNodes)}</b>`,
      `├ 存活节点：<b>${this.num(summary.aliveNodes)}</b>`,
      `├ 测速合格：<b>${this.num(summary.speedNodes)}</b>`,
      `├ 优质池：<b>${this.num(summary.reusableNodes)}</b>`,
      `└ 国家数量：<b>${this.num(summary.countries)}</b>`,
      '',
      '🔗 <b>订阅链接</b>',
      ...this.artifactLines(artifacts)
    ]
    if (!settings.publicBaseUrl) {
      lines.push('', '⚠️ <i>未设置公开域名，Telegram 中的订阅链接可能只适合本机访问。</i>')
    }
    await this.sendHtml(lines.join('\n'))
    return { sent: true }
  }

  private artifactLines(artifacts: ArtifactEntity[]): string[] {
    const groups = new Map<string, ArtifactEntity[]>()
    for (const artifact of artifacts) {
      const title = artifact.title.replace(/\s+(Clash|v2ray)$/i, '')
      const group = groups.get(title)
      if (group) group.push(artifact)
      else groups.set(title, [artifact])
    }
    const ordered = Array.from(groups.entries()).sort(([a], [b]) => this.groupOrder(a) - this.groupOrder(b))
    const lines: string[] = []
    for (const [title, items] of ordered) {
      const nodeCount = Math.max(...items.map((item) => item.nodeCount))
      const links = items
        .sort((a, b) => a.format.localeCompare(b.format))
        .map((item) => `<a href="${escapeHtml(this.absoluteUrl(item.url))}">${item.format === 'clash' ? 'Clash' : 'V2Ray'}</a>`)
        .join(' | ')
      lines.push(
        '',
        `${this.groupIcon(title)} <b>${escapeHtml(title)}</b>`,
        `├ 节点数量：<b>${this.num(nodeCount)}</b>`,
        `└ 订阅链接：${links}`
      )
    }
    return lines
  }

  private absoluteUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) return url
    const base = this.store.getSettings().publicBaseUrl.replace(/\/+$/, '') || 'http://127.0.0.1:8080'
    return `${base}${url.startsWith('/') ? url : `/${url}`}`
  }

  private groupIcon(title: string): string {
    if (/活跃|存活/.test(title)) return '🟢'
    if (/测速|速度/.test(title)) return '🚀'
    if (/OpenAI/i.test(title)) return '🤖'
    if (/YouTube/i.test(title)) return '▶️'
    if (/Netflix/i.test(title)) return '🎬'
    if (/Disney/i.test(title)) return '🏰'
    if (/国家/.test(title)) return '🌍'
    if (/优质/.test(title)) return '⭐'
    return '📦'
  }

  private groupOrder(title: string): number {
    if (/活跃|存活/.test(title)) return 10
    if (/测速|速度/.test(title)) return 20
    if (/优质/.test(title)) return 30
    if (/国家/.test(title)) return 40
    if (/OpenAI/i.test(title)) return 50
    if (/YouTube/i.test(title)) return 60
    if (/Netflix/i.test(title)) return 70
    if (/Disney/i.test(title)) return 80
    return 100
  }

  private runTitle(run: TestRunEntity | null | undefined): string {
    const labels: Record<string, string> = {
      full: '全量任务',
      alive: '测活任务',
      speed: '测速任务',
      unlock: '解锁检测',
      country_backup: '国家备份',
      fetch: '订阅刷新'
    }
    return labels[run?.type ?? ''] ?? '任务'
  }

  private num(value: unknown): string {
    return Number(value ?? 0).toLocaleString('zh-CN')
  }

  private formatDate(value: string): string {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString('zh-CN', { hour12: false })
  }

  private async sendHtml(html: string): Promise<void> {
    const settings = this.store.getSettings()
    const botToken = settings.telegram.botToken
    const chatId = settings.telegram.chatId
    if (!botToken || !chatId) throw new Error('Telegram Bot Token 或 Chat ID 未配置')
    const apiBaseUrl = this.normalizeApiBaseUrl(settings.telegram.apiBaseUrl)
    const res = await fetch(`${apiBaseUrl}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) {
      throw new Error(`Telegram HTTP ${res.status}`)
    }
  }

  private normalizeApiBaseUrl(value: string | null | undefined): string {
    return (value || 'https://api.telegram.org').replace(/\/+$/, '')
  }
}
