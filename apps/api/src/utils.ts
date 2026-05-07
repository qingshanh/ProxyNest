import crypto from 'node:crypto'
import type { FastifyReply } from 'fastify'
import type { ApiResponse } from './types'

export const nowIso = (): string => new Date().toISOString()

export const newId = (prefix: string): string => {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`
}

export const sha256 = (value: string): string => {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export const randomToken = (): string => {
  return crypto.randomBytes(32).toString('base64url')
}

export const safeJsonParse = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export const sendOk = <T>(reply: FastifyReply, data: T): FastifyReply => {
  const body: ApiResponse<T> = { ok: true, data }
  return reply.send(body)
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export const toIntBool = (value: boolean): number => (value ? 1 : 0)
export const fromIntBool = (value: unknown): boolean => Number(value) === 1

export const toMBps = (bps: number | null | undefined): number | null => {
  if (!bps || bps <= 0) return null
  return Math.round((bps / 1024 / 1024) * 10) / 10
}

export const chunk = <T>(items: T[], size: number): T[][] => {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size))
  }
  return result
}

export const abortError = (message = 'aborted'): Error => {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError()
}

export const withTimeoutSignal = (timeoutMs: number, parent?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))
  if (!parent) return timeout
  if (parent.aborted) return parent
  const abortSignalAny = (AbortSignal as unknown as {
    any?: (signals: AbortSignal[]) => AbortSignal
  }).any
  if (typeof abortSignalAny === 'function') return abortSignalAny([parent, timeout])
  const controller = new AbortController()
  const abort = () => controller.abort()
  parent.addEventListener('abort', abort, { once: true })
  timeout.addEventListener('abort', abort, { once: true })
  return controller.signal
}

export const runLimited = async <T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop?: () => boolean
): Promise<void> => {
  const parsedConcurrency = Number(concurrency)
  const limit = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? Math.floor(parsedConcurrency) : 1
  let cursor = 0
  let firstError: unknown
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length && !firstError && !shouldStop?.()) {
      const index = cursor
      cursor += 1
      try {
        await worker(items[index], index)
      } catch (error) {
        if (!firstError) firstError = error
      }
    }
  })
  await Promise.all(runners)
  if (firstError) throw firstError
}
