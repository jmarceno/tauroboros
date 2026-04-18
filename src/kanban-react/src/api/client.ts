/**
 * API Client - Centralized HTTP client with error handling
 * All API calls go through this layer
 */

import type { ApiError } from '../../../shared/error-codes.ts'

const API_BASE = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_URL || location.origin

export class ApiErrorResponse extends Error {
  code?: string
  details?: Record<string, unknown>
  status: number

  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiErrorResponse'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * Core request function with timeout and error handling
 */
export async function apiRequest<T>(
  path: string,
  options?: RequestInit,
  timeoutMs = 60000
): Promise<T> {
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(new Error('Request timeout')), timeoutMs)

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: abortController.signal,
      ...options,
    })

    clearTimeout(timeout)

    if (!res.ok) {
      const text = await res.text()
      let errorMessage = `Request failed (${res.status})`
      let errorCode: string | undefined
      let errorDetails: Record<string, unknown> | undefined

      try {
        const parsed = JSON.parse(text) as ApiError
        if (parsed?.error) errorMessage = parsed.error
        else errorMessage = text || errorMessage
        errorCode = parsed?.code
        errorDetails = parsed?.details
      } catch {
        errorMessage = text || errorMessage
      }

      throw new ApiErrorResponse(errorMessage, res.status, errorCode, errorDetails)
    }

    return res.status === 204 ? undefined as T : res.json()
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Convenience methods for common HTTP verbs
 */
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
  // For DELETE requests with body (non-standard but sometimes needed)
  request: <T>(method: string, path: string, body?: unknown) => apiRequest<T>(path, {
    method,
    body: body ? JSON.stringify(body) : undefined,
  }),
}
