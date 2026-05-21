import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from './config'
import { throwIfAborted, withTimeoutSignal } from './utils'

type GeoResult = {
  countryCode: string | null
  countryName: string | null
}

export type GeoIpUpdateResult = {
  updatedAt: string
  bytes: number
  filePath: string
}

export type GeoLookupOptions = {
  mode?: 'local_with_api_fallback' | 'local_only' | 'api_only'
  apiUrl?: string
}

export const countryNamesZh: Record<string, string> = {
  AD: '安道尔',
  AE: '阿联酋',
  AF: '阿富汗',
  AG: '安提瓜和巴布达',
  AL: '阿尔巴尼亚',
  AM: '亚美尼亚',
  AO: '安哥拉',
  AR: '阿根廷',
  AT: '奥地利',
  AU: '澳大利亚',
  AZ: '阿塞拜疆',
  BA: '波黑',
  BB: '巴巴多斯',
  BD: '孟加拉',
  BE: '比利时',
  BF: '布基纳法索',
  BG: '保加利亚',
  BH: '巴林',
  BN: '文莱',
  BO: '玻利维亚',
  BR: '巴西',
  BS: '巴哈马',
  BT: '不丹',
  BW: '博茨瓦纳',
  BY: '白俄罗斯',
  BZ: '伯利兹',
  CA: '加拿大',
  CH: '瑞士',
  CL: '智利',
  CN: '中国',
  CO: '哥伦比亚',
  CR: '哥斯达黎加',
  CY: '塞浦路斯',
  CZ: '捷克',
  DE: '德国',
  DK: '丹麦',
  DO: '多米尼加',
  DZ: '阿尔及利亚',
  EC: '厄瓜多尔',
  EE: '爱沙尼亚',
  EG: '埃及',
  ES: '西班牙',
  FI: '芬兰',
  FR: '法国',
  GB: '英国',
  GE: '格鲁吉亚',
  GH: '加纳',
  GR: '希腊',
  GT: '危地马拉',
  HK: '香港',
  HN: '洪都拉斯',
  HR: '克罗地亚',
  HU: '匈牙利',
  ID: '印度尼西亚',
  IE: '爱尔兰',
  IL: '以色列',
  IN: '印度',
  IQ: '伊拉克',
  IR: '伊朗',
  IS: '冰岛',
  IT: '意大利',
  JM: '牙买加',
  JO: '约旦',
  JP: '日本',
  KE: '肯尼亚',
  KG: '吉尔吉斯斯坦',
  KH: '柬埔寨',
  KR: '韩国',
  KW: '科威特',
  KZ: '哈萨克斯坦',
  LA: '老挝',
  LB: '黎巴嫩',
  LI: '列支敦士登',
  LK: '斯里兰卡',
  LT: '立陶宛',
  LU: '卢森堡',
  LV: '拉脱维亚',
  MA: '摩洛哥',
  MC: '摩纳哥',
  MD: '摩尔多瓦',
  ME: '黑山',
  MK: '北马其顿',
  MM: '缅甸',
  MN: '蒙古',
  MO: '澳门',
  MT: '马耳他',
  MX: '墨西哥',
  MY: '马来西亚',
  NG: '尼日利亚',
  NL: '荷兰',
  NO: '挪威',
  NP: '尼泊尔',
  NZ: '新西兰',
  OM: '阿曼',
  PA: '巴拿马',
  PE: '秘鲁',
  PH: '菲律宾',
  PK: '巴基斯坦',
  PL: '波兰',
  PR: '波多黎各',
  PT: '葡萄牙',
  QA: '卡塔尔',
  RO: '罗马尼亚',
  RS: '塞尔维亚',
  RU: '俄罗斯',
  SA: '沙特',
  SE: '瑞典',
  SG: '新加坡',
  SI: '斯洛文尼亚',
  SK: '斯洛伐克',
  TH: '泰国',
  TR: '土耳其',
  TW: '台湾',
  UA: '乌克兰',
  US: '美国',
  UY: '乌拉圭',
  UZ: '乌兹别克斯坦',
  VE: '委内瑞拉',
  VN: '越南',
  ZA: '南非'
}

const countryAliases: Array<{ code: string; pattern: RegExp }> = [
  { code: 'US', pattern: /united states|america|usa|los angeles|san jose|new york|dallas|seattle|chicago|ashburn/i },
  { code: 'JP', pattern: /japan|tokyo|osaka|saitama/i },
  { code: 'SG', pattern: /singapore/i },
  { code: 'HK', pattern: /hong ?kong/i },
  { code: 'TW', pattern: /taiwan|taipei/i },
  { code: 'KR', pattern: /korea|seoul/i },
  { code: 'GB', pattern: /united kingdom|britain|london|manchester/i },
  { code: 'DE', pattern: /germany|frankfurt|berlin/i },
  { code: 'FR', pattern: /france|paris/i },
  { code: 'NL', pattern: /netherlands|holland|amsterdam/i },
  { code: 'CA', pattern: /canada|toronto|vancouver|montreal/i },
  { code: 'AU', pattern: /australia|sydney|melbourne/i },
  { code: 'RU', pattern: /russia|moscow/i },
  { code: 'IN', pattern: /india|mumbai|delhi/i },
  { code: 'TH', pattern: /thailand|bangkok/i },
  { code: 'VN', pattern: /vietnam|hanoi|ho chi minh/i },
  { code: 'PH', pattern: /philippines|manila/i },
  { code: 'ID', pattern: /indonesia|jakarta/i },
  { code: 'MY', pattern: /malaysia|kuala lumpur/i },
  { code: 'TR', pattern: /turkey|istanbul/i },
  { code: 'BR', pattern: /brazil|sao paulo/i },
  { code: 'IT', pattern: /italy|milan|rome/i },
  { code: 'ES', pattern: /spain|madrid/i },
  { code: 'SE', pattern: /sweden|stockholm/i },
  { code: 'CH', pattern: /switzerland|zurich/i },
  { code: 'PL', pattern: /poland|warsaw/i },
  { code: 'AE', pattern: /uae|dubai/i },
  { code: 'AR', pattern: /argentina|buenos aires/i },
  { code: 'CL', pattern: /chile|santiago/i },
  { code: 'FI', pattern: /finland|helsinki/i },
  { code: 'IE', pattern: /ireland|dublin/i },
  { code: 'MX', pattern: /mexico|mexico city/i },
  { code: 'NO', pattern: /norway|oslo/i },
  { code: 'NZ', pattern: /new zealand|auckland/i },
  { code: 'PT', pattern: /portugal|lisbon/i },
  { code: 'ZA', pattern: /south africa|johannesburg/i },
  { code: 'US', pattern: /美国|美國|洛杉矶|圣何塞|西雅图|纽约|达拉斯|us|usa|united states|america/i },
  { code: 'JP', pattern: /日本|东京|大阪|埼玉|jp|japan|tokyo|osaka/i },
  { code: 'SG', pattern: /新加坡|狮城|sg|singapore/i },
  { code: 'HK', pattern: /香港|港|hk|hong ?kong/i },
  { code: 'TW', pattern: /台湾|台灣|台北|tw|taiwan/i },
  { code: 'KR', pattern: /韩国|韓國|首尔|kr|korea|seoul/i },
  { code: 'GB', pattern: /英国|英國|伦敦|gb|uk|united kingdom|britain|london/i },
  { code: 'DE', pattern: /德国|德國|法兰克福|de|germany|frankfurt/i },
  { code: 'FR', pattern: /法国|法國|巴黎|fr|france|paris/i },
  { code: 'NL', pattern: /荷兰|荷蘭|阿姆斯特丹|nl|netherlands|holland|amsterdam/i },
  { code: 'CA', pattern: /加拿大|多伦多|温哥华|ca|canada|toronto|vancouver/i },
  { code: 'AU', pattern: /澳大利亚|澳洲|悉尼|au|australia|sydney/i },
  { code: 'RU', pattern: /俄罗斯|俄羅斯|莫斯科|ru|russia|moscow/i },
  { code: 'IN', pattern: /印度|孟买|in|india|mumbai/i },
  { code: 'TH', pattern: /泰国|泰國|曼谷|th|thailand|bangkok/i },
  { code: 'VN', pattern: /越南|胡志明|vn|vietnam/i },
  { code: 'PH', pattern: /菲律宾|菲律賓|马尼拉|ph|philippines|manila/i },
  { code: 'ID', pattern: /印度尼西亚|印尼|雅加达|id|indonesia|jakarta/i },
  { code: 'MY', pattern: /马来西亚|馬來西亞|吉隆坡|my|malaysia/i },
  { code: 'TR', pattern: /土耳其|伊斯坦布尔|tr|turkey|istanbul/i },
  { code: 'BR', pattern: /巴西|圣保罗|br|brazil/i },
  { code: 'IT', pattern: /意大利|米兰|it|italy|milan/i },
  { code: 'ES', pattern: /西班牙|马德里|es|spain|madrid/i },
  { code: 'SE', pattern: /瑞典|斯德哥尔摩|se|sweden/i },
  { code: 'CH', pattern: /瑞士|苏黎世|ch|switzerland|zurich/i },
  { code: 'PL', pattern: /波兰|华沙|pl|poland|warsaw/i },
  { code: 'AE', pattern: /阿联酋|迪拜|ae|uae|dubai/i }
]

export const countryNameFromCode = (code: string | null | undefined): string | null => {
  if (!code) return null
  const normalized = code.toUpperCase()
  return countryNamesZh[normalized] || normalized
}

const countryCodeFromFlag = (text: string): string | null => {
  const match = /[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]/u.exec(text)
  if (!match) return null
  const chars = Array.from(match[0])
  if (chars.length !== 2) return null
  const code = chars
    .map((char) => String.fromCharCode(char.codePointAt(0)! - 0x1f1e6 + 65))
    .join('')
  return /^[A-Z]{2}$/.test(code) ? code : null
}

export const inferCountryFromText = (text: string): GeoResult => {
  const flagCode = countryCodeFromFlag(text)
  if (flagCode) {
    return {
      countryCode: flagCode,
      countryName: countryNameFromCode(flagCode)
    }
  }
  for (const item of countryAliases) {
    if (item.pattern.test(text)) {
      return {
        countryCode: item.code,
        countryName: countryNameFromCode(item.code)
      }
    }
  }
  return { countryCode: null, countryName: null }
}

export class GeoIpService {
  private reader: { get(ip: string): unknown } | null = null
  private triedLocal = false

  constructor(private readonly config: AppConfig) {}

  async lookup(ip: string | null | undefined, options: GeoLookupOptions = {}, signal?: AbortSignal): Promise<GeoResult> {
    throwIfAborted(signal)
    if (!ip) return { countryCode: null, countryName: null }
    const mode = options.mode ?? 'local_with_api_fallback'

    if (mode === 'api_only') return this.lookupApi(ip, options.apiUrl, signal)

    const local = await this.lookupLocal(ip)
    if (local.countryCode || mode === 'local_only') return local

    return this.lookupApi(ip, options.apiUrl, signal)
  }

  async updateDatabase(databaseUrl: string, signal?: AbortSignal): Promise<GeoIpUpdateResult> {
    const url = databaseUrl || 'https://downloads.ip66.dev/db/ip66.mmdb'
    throwIfAborted(signal)
    const dbPath = this.localDbPath()
    const tmpPath = `${dbPath}.download`
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const res = await fetch(url, { signal: withTimeoutSignal(60000, signal) })
    if (!res.ok) throw new Error(`GeoIP database download HTTP ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.byteLength < 1024 * 1024) throw new Error('GeoIP database download is too small')
    fs.writeFileSync(tmpPath, buffer)
    fs.renameSync(tmpPath, dbPath)
    this.reader = null
    this.triedLocal = false
    return {
      updatedAt: new Date().toISOString(),
      bytes: buffer.byteLength,
      filePath: dbPath
    }
  }

  private async lookupLocal(ip: string): Promise<GeoResult> {
    if (!this.triedLocal) {
      this.triedLocal = true
      const dbPath = this.localDbPath()
      if (fs.existsSync(dbPath)) {
        try {
          const maxmind = await import('maxmind')
          this.reader = await maxmind.open(dbPath)
        } catch {
          this.reader = null
        }
      }
    }
    if (!this.reader) return { countryCode: null, countryName: null }
    try {
      const result = this.reader.get(ip) as {
        country?: string | { iso_code?: string; names?: Record<string, string> }
        registered_country?: { iso_code?: string; names?: Record<string, string> }
        country_code?: string
        countryCode?: string
        country_name?: string
        countryName?: string
      } | null
      const countryObject = typeof result?.country === 'object' ? result.country : null
      const code = countryObject?.iso_code || result?.registered_country?.iso_code || result?.country_code || result?.countryCode || null
      const name =
        countryObject?.names?.['zh-CN'] ||
        countryObject?.names?.en ||
        result?.country_name ||
        result?.countryName ||
        (typeof result?.country === 'string' ? result.country : null)
      return {
        countryCode: code,
        countryName: code ? countryNameFromCode(code) || name || code : null
      }
    } catch {
      return { countryCode: null, countryName: null }
    }
  }

  private async lookupApi(ip: string, apiUrl?: string, signal?: AbortSignal): Promise<GeoResult> {
    try {
      throwIfAborted(signal)
      const url = this.buildApiUrl(ip, apiUrl)
      const res = await fetch(url, {
        signal: withTimeoutSignal(5000, signal)
      })
      if (!res.ok) return { countryCode: null, countryName: null }
      const json = (await res.json()) as {
        status?: string
        country?: string
        countryName?: string
        country_name?: string
        countryCode?: string
        country_code?: string
        code?: string
      }
      if (json.status && json.status !== 'success') return { countryCode: null, countryName: null }
      const countryCode =
        json.countryCode ||
        json.country_code ||
        json.code ||
        (json.country && /^[A-Za-z]{2}$/.test(json.country) ? json.country : undefined)
      if (!countryCode) return { countryCode: null, countryName: null }
      return {
        countryCode,
        countryName: countryNameFromCode(countryCode) || json.country || json.countryName || json.country_name || countryCode
      }
    } catch {
      return { countryCode: null, countryName: null }
    }
  }

  private buildApiUrl(ip: string, apiUrl?: string): string {
    const trimmed = apiUrl?.trim()
    if (!trimmed) {
      return `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode`
    }
    if (trimmed.includes('{ip}')) return trimmed.replace(/\{ip\}/g, encodeURIComponent(ip))
    const separator = trimmed.includes('?') ? '&' : '?'
    return `${trimmed}${separator}ip=${encodeURIComponent(ip)}`
  }

  private localDbPath(): string {
    return path.join(this.config.dataDir, 'geoip', 'GeoLite2-Country.mmdb')
  }
}
