const rawGithubHost = 'https://raw.githubusercontent.com/'

export const normalizeProxyPrefix = (prefix: string | null | undefined): string => {
  const trimmed = String(prefix ?? '').trim()
  if (!trimmed) return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

export const toGithubRawUrl = (input: string): string => {
  const value = input.trim()
  if (value.startsWith(rawGithubHost)) return value
  try {
    const url = new URL(value)
    if (url.hostname !== 'github.com') return value
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 5) return value
    const [owner, repo, mode, branch, ...rest] = parts
    if (!owner || !repo || !branch || !rest.length) return value
    if (mode !== 'raw' && mode !== 'blob') return value
    return `${rawGithubHost}${owner}/${repo}/${branch}/${rest.map(encodeURIComponent).join('/')}`
  } catch {
    return value
  }
}

export const stripGithubRawProxyPrefix = (input: string, proxyPrefix: string | null | undefined): string => {
  const value = input.trim()
  const prefix = normalizeProxyPrefix(proxyPrefix)
  if (prefix && value.startsWith(prefix)) return value.slice(prefix.length)
  return value
}

export const isGithubRawUrl = (input: string, proxyPrefix = ''): boolean => {
  return stripGithubRawProxyPrefix(toGithubRawUrl(input), proxyPrefix).startsWith(rawGithubHost)
}

export const applyGithubRawProxy = (input: string, proxyPrefix: string | null | undefined): string => {
  const value = input.trim()
  const prefix = normalizeProxyPrefix(proxyPrefix)
  if (!prefix) return toGithubRawUrl(value)
  if (value.startsWith(prefix)) return value
  const raw = toGithubRawUrl(value)
  if (!raw.startsWith(rawGithubHost)) return value
  return `${prefix}${raw}`
}

export const normalizeSubscriptionUrl = (
  input: string,
  proxyPrefix: string | null | undefined
): { url: string; originalUrl: string | null; isGithubRaw: boolean } => {
  const originalUrl = input.trim()
  const url = applyGithubRawProxy(originalUrl, proxyPrefix)
  const raw = stripGithubRawProxyPrefix(url, proxyPrefix)
  return {
    url,
    originalUrl: originalUrl === url ? null : originalUrl,
    isGithubRaw: raw.startsWith(rawGithubHost)
  }
}
