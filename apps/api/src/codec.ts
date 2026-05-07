import crypto from 'node:crypto'
import YAML from 'yaml'
import type { NodeEntity, NormalizedNode, ParseResult, ProxyProtocol } from './types'
import { newId } from './utils'

const protocolAliases: Record<string, ProxyProtocol> = {
  vmess: 'vmess',
  vless: 'vless',
  trojan: 'trojan',
  ss: 'ss',
  shadowsocks: 'ss',
  hysteria2: 'hysteria2',
  hy2: 'hysteria2',
  tuic: 'tuic'
}

export const parseSubscriptionContent = (content: string, sourceId: string): ParseResult => {
  const normalized = content.trim()
  const yamlNodes = parseClashYaml(normalized, sourceId)
  const textCandidates = collectTextCandidates(normalized)
  const uriNodes = textCandidates.flatMap((line) => {
    const parsed = parseUriNode(line, sourceId)
    return parsed ? [parsed] : []
  })
  const nodes = mergeParsedNodes([...yamlNodes, ...uriNodes])
  const typeSummary = nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.protocol] = (acc[node.protocol] ?? 0) + 1
    return acc
  }, {})
  return {
    format: yamlNodes.length && uriNodes.length ? 'mixed' : yamlNodes.length ? 'clash' : uriNodes.length ? 'v2ray' : 'unknown',
    nodes,
    typeSummary
  }
}

export const exportV2raySubscription = (nodes: NodeEntity[]): string => {
  const lines = nodes
    .map((node) => node.rawUri ? renameUri(node.rawUri, node.displayName) : clashToUri(node))
    .filter((line): line is string => Boolean(line))
  return Buffer.from(lines.join('\n'), 'utf8').toString('base64')
}

export const exportClashSubscription = (nodes: NodeEntity[]): string => {
  const proxies = nodes
    .map((node) => toClashProxy(node))
    .filter((item): item is Record<string, unknown> => Boolean(item))
  const names = proxies.map((proxy) => String(proxy.name))
  return YAML.stringify({
    port: 7890,
    'socks-port': 7891,
    'allow-lan': true,
    mode: 'rule',
    'log-level': 'info',
    proxies,
    'proxy-groups': [
      {
        name: 'ProxyNest',
        type: 'select',
        proxies: names.length ? names : ['DIRECT']
      }
    ],
    rules: ['MATCH,ProxyNest']
  })
}

export const toClashProxy = (node: NodeEntity | NormalizedNode): Record<string, unknown> | null => {
  const clash = 'clash' in node ? node.clash : null
  if (clash) {
    return {
      ...clash,
      name: node.displayName
    }
  }
  const rawUri = 'rawUri' in node ? node.rawUri : null
  if (!rawUri) return null
  const parsed = parseUriNode(rawUri, 'export')
  if (!parsed?.clash) return null
  return {
    ...parsed.clash,
    name: node.displayName
  }
}

const parseClashYaml = (content: string, sourceId: string): NormalizedNode[] => {
  try {
    const doc = YAML.parse(content) as { proxies?: unknown }
    if (!doc || !Array.isArray(doc.proxies)) return []
    return doc.proxies.flatMap((proxy) => {
      if (!proxy || typeof proxy !== 'object') return []
      const item = proxy as Record<string, unknown>
      const protocol = protocolAliases[String(item.type || '').toLowerCase()] ?? 'unknown'
      const server = item.server ? String(item.server) : ''
      const port = Number(item.port || 0)
      if (!server || !port) return []
      const name = String(item.name || `${server}:${port}`)
      const clash = { ...item, name }
      const fingerprint = fingerprintConfig(protocol, clash)
      return [
        {
          id: newId('node'),
          fingerprint,
          protocol,
          originalName: name,
          displayName: name,
          server,
          port,
          clash,
          sourceIds: [sourceId]
        }
      ]
    })
  } catch {
    return []
  }
}

const collectTextCandidates = (content: string): string[] => {
  const candidates = new Set<string>()
  const addLines = (value: string) => {
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        if (/^(vmess|vless|trojan|ss|hysteria2|hy2|tuic):\/\//i.test(line)) {
          candidates.add(line)
        }
      })
  }
  addLines(content)
  const decoded = tryDecodeBase64(content)
  if (decoded) addLines(decoded)
  return [...candidates]
}

const parseUriNode = (uri: string, sourceId: string): NormalizedNode | null => {
  const protocol = protocolAliases[uri.slice(0, uri.indexOf('://')).toLowerCase()] ?? 'unknown'
  try {
    if (protocol === 'vmess') return parseVmess(uri, sourceId)
    if (protocol === 'ss') return parseShadowsocks(uri, sourceId)
    if (['vless', 'trojan', 'hysteria2', 'tuic'].includes(protocol)) {
      return parseUrlLike(uri, sourceId, protocol)
    }
    return null
  } catch {
    return null
  }
}

const parseVmess = (uri: string, sourceId: string): NormalizedNode | null => {
  const payload = uri.replace(/^vmess:\/\//i, '')
  const decoded = tryDecodeBase64(payload)
  if (!decoded) return null
  const vmess = JSON.parse(decoded) as Record<string, unknown>
  const server = String(vmess.add || '')
  const port = Number(vmess.port || 0)
  if (!server || !port) return null
  const name = String(vmess.ps || `${server}:${port}`)
  const clash = {
    name,
    type: 'vmess',
    server,
    port,
    uuid: String(vmess.id || ''),
    alterId: Number(vmess.aid || 0),
    cipher: String(vmess.scy || 'auto'),
    tls: String(vmess.tls || '') === 'tls',
    network: String(vmess.net || 'tcp'),
    'ws-opts': String(vmess.net || '') === 'ws'
      ? {
          path: String(vmess.path || ''),
          headers: vmess.host ? { Host: String(vmess.host) } : undefined
        }
      : undefined,
    servername: vmess.sni ? String(vmess.sni) : undefined
  }
  return {
    id: newId('node'),
    fingerprint: fingerprintConfig('vmess', vmess),
    protocol: 'vmess',
    originalName: name,
    displayName: name,
    server,
    port,
    rawUri: uri,
    clash,
    sourceIds: [sourceId]
  }
}

const parseUrlLike = (uri: string, sourceId: string, protocol: ProxyProtocol): NormalizedNode | null => {
  const url = new URL(uri)
  const server = url.hostname
  const port = Number(url.port || 0)
  if (!server || !port) return null
  const name = decodeURIComponent(url.hash.replace(/^#/, '')) || `${server}:${port}`
  const params = Object.fromEntries(url.searchParams.entries())
  const clash: Record<string, unknown> = {
    name,
    type: protocol === 'hysteria2' ? 'hysteria2' : protocol,
    server,
    port,
    udp: true
  }
  if (protocol === 'vless') {
    clash.uuid = decodeURIComponent(url.username)
    clash.tls = params.security === 'tls' || params.security === 'reality'
    clash.network = params.type || 'tcp'
    if (params.sni) clash.servername = params.sni
    if (params.flow) clash.flow = params.flow
    if (params.path || params.host) {
      clash['ws-opts'] = {
        path: params.path || '/',
        headers: params.host ? { Host: params.host } : undefined
      }
    }
    if (params.security === 'reality') {
      clash['reality-opts'] = {
        'public-key': params.pbk,
        'short-id': params.sid
      }
    }
  } else if (protocol === 'trojan') {
    clash.password = decodeURIComponent(url.username)
    clash.sni = params.sni
    clash.skipCertVerify = params.allowInsecure === '1'
  } else if (protocol === 'hysteria2') {
    clash.password = decodeURIComponent(url.username)
    clash.sni = params.sni
    clash['skip-cert-verify'] = params.insecure === '1'
  } else if (protocol === 'tuic') {
    clash.uuid = decodeURIComponent(url.username)
    clash.password = decodeURIComponent(url.password)
    clash.sni = params.sni
  }
  return {
    id: newId('node'),
    fingerprint: fingerprintConfig(protocol, { protocol, server, port, username: url.username, password: url.password, params }),
    protocol,
    originalName: name,
    displayName: name,
    server,
    port,
    rawUri: uri,
    clash,
    sourceIds: [sourceId]
  }
}

const parseShadowsocks = (uri: string, sourceId: string): NormalizedNode | null => {
  const noScheme = uri.replace(/^ss:\/\//i, '')
  const hashIndex = noScheme.indexOf('#')
  const name = hashIndex >= 0 ? decodeURIComponent(noScheme.slice(hashIndex + 1)) : ''
  const body = hashIndex >= 0 ? noScheme.slice(0, hashIndex) : noScheme
  const pluginIndex = body.indexOf('?')
  const bodyWithoutParams = pluginIndex >= 0 ? body.slice(0, pluginIndex) : body
  let decoded = bodyWithoutParams
  if (!bodyWithoutParams.includes('@')) {
    decoded = tryDecodeBase64(bodyWithoutParams) || bodyWithoutParams
  }
  const at = decoded.lastIndexOf('@')
  if (at < 0) return null
  const methodPassword = decoded.slice(0, at)
  const endpoint = decoded.slice(at + 1)
  const colon = endpoint.lastIndexOf(':')
  if (colon < 0) return null
  const server = endpoint.slice(0, colon)
  const port = Number(endpoint.slice(colon + 1))
  if (!server || !port) return null
  const methodPasswordDecoded = decodeURIComponent(methodPassword)
  const methodColon = methodPasswordDecoded.indexOf(':')
  const cipher = methodColon >= 0 ? methodPasswordDecoded.slice(0, methodColon) : 'aes-128-gcm'
  const password = methodColon >= 0 ? methodPasswordDecoded.slice(methodColon + 1) : methodPasswordDecoded
  const displayName = name || `${server}:${port}`
  const clash = {
    name: displayName,
    type: 'ss',
    server,
    port,
    cipher,
    password,
    udp: true
  }
  return {
    id: newId('node'),
    fingerprint: fingerprintConfig('ss', { server, port, cipher, password }),
    protocol: 'ss',
    originalName: displayName,
    displayName,
    server,
    port,
    rawUri: uri,
    clash,
    sourceIds: [sourceId]
  }
}

const tryDecodeBase64 = (value: string): string | null => {
  try {
    const compact = value.replace(/\s+/g, '')
    const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, '=')
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    if (!decoded || decoded.includes('\u0000')) return null
    return decoded
  } catch {
    return null
  }
}

const mergeParsedNodes = (nodes: NormalizedNode[]): NormalizedNode[] => {
  const byFingerprint = new Map<string, NormalizedNode>()
  for (const node of nodes) {
    if (!byFingerprint.has(node.fingerprint)) {
      byFingerprint.set(node.fingerprint, node)
    }
  }
  return [...byFingerprint.values()]
}

const renameUri = (uri: string, name: string): string => {
  if (/^vmess:\/\//i.test(uri)) {
    const decoded = tryDecodeBase64(uri.replace(/^vmess:\/\//i, ''))
    if (!decoded) return uri
    try {
      const json = JSON.parse(decoded) as Record<string, unknown>
      json.ps = name
      return `vmess://${Buffer.from(JSON.stringify(json), 'utf8').toString('base64')}`
    } catch {
      return uri
    }
  }
  const hash = uri.indexOf('#')
  const base = hash >= 0 ? uri.slice(0, hash) : uri
  return `${base}#${encodeURIComponent(name)}`
}

const clashToUri = (node: NodeEntity): string | null => {
  const clash = node.clash
  if (!clash) return null
  const type = String(clash.type || node.protocol)
  if (type === 'vmess') {
    const vmess = {
      v: '2',
      ps: node.displayName,
      add: node.server,
      port: String(node.port),
      id: String(clash.uuid || ''),
      aid: String(clash.alterId || 0),
      scy: String(clash.cipher || 'auto'),
      net: String(clash.network || 'tcp'),
      type: 'none',
      host: '',
      path: '',
      tls: clash.tls ? 'tls' : ''
    }
    return `vmess://${Buffer.from(JSON.stringify(vmess), 'utf8').toString('base64')}`
  }
  if (type === 'ss') {
    const user = Buffer.from(`${String(clash.cipher || 'aes-128-gcm')}:${String(clash.password || '')}`, 'utf8').toString('base64url')
    return `ss://${user}@${node.server}:${node.port}#${encodeURIComponent(node.displayName)}`
  }
  if (type === 'trojan') {
    return `trojan://${encodeURIComponent(String(clash.password || ''))}@${node.server}:${node.port}#${encodeURIComponent(node.displayName)}`
  }
  if (type === 'vless') {
    return `vless://${encodeURIComponent(String(clash.uuid || ''))}@${node.server}:${node.port}?security=${clash.tls ? 'tls' : 'none'}#${encodeURIComponent(node.displayName)}`
  }
  return null
}

const fingerprintConfig = (protocol: ProxyProtocol, config: Record<string, unknown>): string => {
  const normalized = stripVolatileFields(config)
  return crypto
    .createHash('sha256')
    .update(`${protocol}:${stableStringify(normalized)}`)
    .digest('hex')
}

const stripVolatileFields = (value: Record<string, unknown>): Record<string, unknown> => {
  const clone: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (['name', 'ps', 'remarks'].includes(key)) continue
    if (item === undefined || item === null || item === '') continue
    clone[key] = item
  }
  return clone
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`
}
