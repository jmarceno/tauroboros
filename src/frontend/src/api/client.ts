/**
 * API Client - Centralized Effect-based HTTP client with typed failures.
 */

import { Effect, Schema } from 'effect'
import { detectErrorCodeFromMessage, type ApiError, type ErrorCode } from './error-codes.ts'

const API_BASE = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_URL || location.origin

export class ApiClientError extends Schema.TaggedError<ApiClientError>()('ApiClientError', {
  message: Schema.String,
  path: Schema.String,
  status: Schema.Number,
  reason: Schema.Literal('network', 'timeout', 'http', 'decode'),
  code: Schema.optional(Schema.String),
  details: Schema.optional(Schema.Unknown),
}) {}

const isApiErrorPayload = (value: unknown): value is ApiError => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as { error?: unknown; code?: unknown; details?: unknown }
  return typeof candidate.error === 'string'
    && (candidate.code === undefined || typeof candidate.code === 'string')
}

const makeApiClientError = (
  path: string,
  status: number,
  reason: 'network' | 'timeout' | 'http' | 'decode',
  message: string,
  code?: ErrorCode,
  details?: unknown,
) => new ApiClientError({
  message,
  path,
  status,
  reason,
  code,
  details,
})

const parseErrorPayload = (path: string, status: number, text: string): ApiClientError => {
  if (!text) {
    return makeApiClientError(path, status, 'http', `Request failed (${status})`)
  }

  try {
    const parsed = JSON.parse(text) as unknown
    if (isApiErrorPayload(parsed)) {
      return makeApiClientError(
        path,
        status,
        'http',
        parsed.error,
        parsed.code ?? detectErrorCodeFromMessage(parsed.error) ?? undefined,
        parsed.details,
      )
    }
  } catch {
    return makeApiClientError(path, status, 'decode', text, detectErrorCodeFromMessage(text) ?? undefined)
  }

  return makeApiClientError(path, status, 'http', text, detectErrorCodeFromMessage(text) ?? undefined)
}

export function apiRequest<T>(
  path: string,
  options?: RequestInit,
  timeoutMs = 60000,
): Effect.Effect<T, ApiClientError> {
  return Effect.gen(function* () {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort('Request timeout'), timeoutMs)

    try {
      const response = yield* Effect.tryPromise({
        try: () => fetch(`${API_BASE}${path}`, {
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          ...options,
        }),
        catch: (cause) => makeApiClientError(
          path,
          0,
          abortController.signal.aborted ? 'timeout' : 'network',
          cause instanceof Error ? cause.message : String(cause),
        ),
      })

      if (!response.ok) {
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) => makeApiClientError(
            path,
            response.status,
            'decode',
            cause instanceof Error ? cause.message : String(cause),
          ),
        })
        return yield* parseErrorPayload(path, response.status, text)
      }

      if (response.status === 204) {
        return undefined as T
      }

      return yield* Effect.tryPromise({
        try: () => response.json() as Promise<T>,
        catch: (cause) => makeApiClientError(
          path,
          response.status,
          'decode',
          cause instanceof Error ? cause.message : String(cause),
        ),
      })
    } finally {
      clearTimeout(timeout)
    }
  })
}

export function runApiEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
}

export function sleepMs(durationMs: number): Promise<void> {
  return runApiEffect(Effect.sleep(`${durationMs} millis`)).then(() => undefined)
}

export const apiClient = {
  get: <T>(path: string) => apiRequest<T>(path),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, {
    method: 'PATCH',
    body: body ? JSON.stringify(body) : undefined,
  }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, {
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined,
  }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
  request: <T>(method: string, path: string, body?: unknown) => apiRequest<T>(path, {
    method,
    body: body ? JSON.stringify(body) : undefined,
  }),
}