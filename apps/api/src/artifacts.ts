import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from './config'
import { exportClashSubscription, exportV2raySubscription } from './codec'
import { countryNameFromCode, inferCountryFromText } from './geoip'
import type { NodeEntity, UnlockPlatform } from './types'
import type { Store } from './store'

const platformTitles: Record<UnlockPlatform, string> = {
  openai: 'OpenAI 解锁',
  youtube: 'YouTube 解锁',
  netflix: 'Netflix 解锁',
  disney: 'Disney+ 解锁'
}

export class ArtifactService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig
  ) {
    fs.mkdirSync(config.artifactsDir, { recursive: true })
  }

  generateStandardArtifacts(perCountry = 2): void {
    const all = this.store.getExportNodes()
    const suspicious = all.filter((node) => node.alive && (node.security?.risk ?? 'unknown') === 'suspicious')
    const exportable = all.filter((node) => (node.security?.risk ?? 'unknown') !== 'suspicious')
    const alive = exportable.filter((node) => node.alive)
    const speed = exportable
      .filter((node) => node.speedQualified)
      .sort((a, b) => (b.speedBps ?? 0) - (a.speedBps ?? 0))
    this.generatePair('alive', '活跃节点', alive)
    this.generatePair('speed', '测速合格节点', speed)
    this.generatePair('suspicious', 'HTTPS 瀹夊叏鍙枒鑺傜偣', suspicious)
    for (const platform of ['openai', 'youtube', 'netflix', 'disney'] as UnlockPlatform[]) {
      const nodes = alive.filter((node) => node.unlock[platform]?.available)
      this.generatePair(`platform/${platform}`, platformTitles[platform], nodes)
    }
    this.generatePair('reusable', '优质节点池', this.store.getReusableNodes())
    this.generatePair('country-backup', '国家备用节点', this.pickCountryBackup(alive, perCountry))
  }

  readPublicArtifact(token: string, wildcardPath: string): { filePath: string; contentType: string } | null {
    const settings = this.store.getSettings()
    if (token !== settings.subToken) return null
    const cleanPath = wildcardPath.replace(/^\/+/, '')
    const artifact = this.store.getArtifactByPublicPath(`/sub/${token}/${cleanPath}`)
    if (!artifact || !fs.existsSync(artifact.filePath)) return null
    return {
      filePath: artifact.filePath,
      contentType: artifact.format === 'clash' ? 'application/yaml; charset=utf-8' : 'text/plain; charset=utf-8'
    }
  }

  private generatePair(slug: string, title: string, nodes: NodeEntity[]): void {
    this.writeArtifact(`${slug.replace(/\//g, '_')}_yaml`, `${title} Clash`, slug, 'yaml', nodes)
    this.writeArtifact(`${slug.replace(/\//g, '_')}_txt`, `${title} v2ray`, slug, 'txt', nodes)
  }

  private writeArtifact(
    key: string,
    title: string,
    slug: string,
    extension: 'yaml' | 'txt',
    nodes: NodeEntity[]
  ): void {
    const settings = this.store.getSettings()
    const relative = `${slug}.${extension}`
    const filePath = path.join(this.config.artifactsDir, relative)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const content = extension === 'yaml' ? exportClashSubscription(nodes) : exportV2raySubscription(nodes)
    fs.writeFileSync(filePath, content, 'utf8')
    this.store.upsertArtifact({
      key,
      title,
      format: extension === 'yaml' ? 'clash' : 'v2ray',
      filePath,
      publicPath: `/sub/${settings.subToken}/${relative.replace(/\\/g, '/')}`,
      nodeCount: nodes.length,
      token: settings.subToken
    })
  }

  private pickCountryBackup(nodes: NodeEntity[], perCountry: number): NodeEntity[] {
    const groups = new Map<string, { label: string; nodes: NodeEntity[] }>()
    for (const node of nodes) {
      const country = this.nodeCountry(node)
      const key = country.key
      const group = groups.get(key)
      if (group) {
        group.nodes.push(node)
      } else {
        groups.set(key, { label: country.label, nodes: [node] })
      }
    }
    const selected: NodeEntity[] = []
    const sortedGroups = Array.from(groups.values()).sort((a, b) => {
      if (a.label === '未知') return 1
      if (b.label === '未知') return -1
      return a.label.localeCompare(b.label, 'zh-CN')
    })
    for (const group of sortedGroups) {
      selected.push(
        ...group.nodes
          .sort((a, b) => this.score(b) - this.score(a) || (a.latencyMs ?? 999999) - (b.latencyMs ?? 999999))
          .slice(0, Math.max(1, perCountry))
      )
    }
    return selected
  }

  private nodeCountry(node: NodeEntity): { key: string; label: string } {
    const inferred = inferCountryFromText(`${node.displayName} ${node.originalName} ${node.server}`)
    const code = (node.countryCode || inferred.countryCode || '').toUpperCase()
    const label = node.countryName || countryNameFromCode(code) || inferred.countryName || '未知'
    return {
      key: code || label,
      label
    }
  }

  private score(node: NodeEntity): number {
    const unlockCount = Object.values(node.unlock).filter((item) => item?.available).length
    return unlockCount * 100 + (node.speedMBps ?? 0) * 10 - (node.latencyMs ?? 9999) / 20
  }
}
