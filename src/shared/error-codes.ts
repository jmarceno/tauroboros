/**
 * Shared error codes between frontend and backend
 *
 * These codes provide a stable contract for error handling that won't break
 * if error messages are reworded. Always use codes for programmatic error detection.
 */

export enum ErrorCode {
  // Planning session errors
  PLANNING_SESSION_NOT_ACTIVE = 'PLANNING_SESSION_NOT_ACTIVE',
  PLANNING_SESSION_NOT_FOUND = 'PLANNING_SESSION_NOT_FOUND',
  PLANNING_SESSION_ALREADY_ACTIVE = 'PLANNING_SESSION_ALREADY_ACTIVE',
  PLANNING_SESSION_CREATE_FAILED = 'PLANNING_SESSION_CREATE_FAILED',
  PLANNING_SESSION_CLOSE_FAILED = 'PLANNING_SESSION_CLOSE_FAILED',
  PLANNING_SESSION_RECONNECT_FAILED = 'PLANNING_SESSION_RECONNECT_FAILED',

  // Message/send errors
  MESSAGE_SEND_FAILED = 'MESSAGE_SEND_FAILED',
  MESSAGE_RETRY_FAILED = 'MESSAGE_RETRY_FAILED',

  // Generic errors
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  NOT_A_PLANNING_SESSION = 'NOT_A_PLANNING_SESSION',
  INVALID_MODEL = 'INVALID_MODEL',
  INVALID_THINKING_LEVEL = 'INVALID_THINKING_LEVEL',
  INVALID_JSON_BODY = 'INVALID_JSON_BODY',
  INVALID_REQUEST_BODY = 'INVALID_REQUEST_BODY',
  INVALID_TASK_CREATION_INPUT = 'INVALID_TASK_CREATION_INPUT',
  INVALID_RANGE = 'INVALID_RANGE',
  INVALID_COLOR = 'INVALID_COLOR',
  INVALID_TASK_GROUP_STATUS = 'INVALID_TASK_GROUP_STATUS',
  PLANNING_PROMPT_NOT_CONFIGURED = 'PLANNING_PROMPT_NOT_CONFIGURED',
  RUN_NOT_FOUND = 'RUN_NOT_FOUND',
  EXECUTION_OPERATION_FAILED = 'EXECUTION_OPERATION_FAILED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  TASK_NOT_FOUND = 'TASK_NOT_FOUND',
  TASK_GROUP_NOT_FOUND = 'TASK_GROUP_NOT_FOUND',
  PROFILE_NOT_FOUND = 'PROFILE_NOT_FOUND',
  CONTAINER_OPERATION_FAILED = 'CONTAINER_OPERATION_FAILED',
  UNSUPPORTED_EVENT_TYPE = 'UNSUPPORTED_EVENT_TYPE',
}

/**
 * Standard error response structure
 */
export interface ApiError {
  error: string
  code?: ErrorCode
  details?: Record<string, unknown>
}

/**
 * Check if an error is a specific error code
 * Works with both Error objects and ApiError responses
 */
export function isErrorCode(error: unknown, code: ErrorCode): boolean {
  if (!error) return false

  // Check if it's an ApiError response
  if (typeof error === 'object' && error !== null) {
    const err = error as { code?: string; error?: string }
    if (err.code === code) return true
    if (err.error?.includes(code)) return true
  }

  // Check if it's an Error object
  if (error instanceof Error) {
    return error.message.includes(code)
  }

  // Check string directly
  if (typeof error === 'string') {
    return error.includes(code)
  }

  return false
}

/**
 * Get error code from error response
 */
export function getErrorCode(error: unknown): ErrorCode | null {
  if (!error) return null

  if (typeof error === 'object' && error !== null) {
    const err = error as { code?: string }
    if (err.code && Object.values(ErrorCode).includes(err.code as ErrorCode)) {
      return err.code as ErrorCode
    }
  }

  return null
}

/**
 * Create a standard API error response
 */
export function createApiError(
  message: string,
  code: ErrorCode,
  details?: Record<string, unknown>
): ApiError {
  return {
    error: message,
    code,
    details,
  }
}

/**
 * Legacy error message mapping for backwards compatibility
 * Maps old error message patterns to new error codes
 */
export const LEGACY_ERROR_PATTERNS: Record<string, ErrorCode> = {
  'Planning session not active': ErrorCode.PLANNING_SESSION_NOT_ACTIVE,
  'Session not found': ErrorCode.SESSION_NOT_FOUND,
  'Not a planning session': ErrorCode.NOT_A_PLANNING_SESSION,
  'Session is already active': ErrorCode.PLANNING_SESSION_ALREADY_ACTIVE,
  'Planning prompt not configured': ErrorCode.PLANNING_PROMPT_NOT_CONFIGURED,
  'Invalid model': ErrorCode.INVALID_MODEL,
  'Invalid thinkingLevel': ErrorCode.INVALID_THINKING_LEVEL,
  'Invalid tasks payload': ErrorCode.INVALID_TASK_CREATION_INPUT,
  'Run not found': ErrorCode.RUN_NOT_FOUND,
  'Task not found': ErrorCode.TASK_NOT_FOUND,
  'Task group not found': ErrorCode.TASK_GROUP_NOT_FOUND,
}

/**
 * Detect error code from legacy error message
 */
export function detectErrorCodeFromMessage(message: string): ErrorCode | null {
  for (const [pattern, code] of Object.entries(LEGACY_ERROR_PATTERNS)) {
    if (message.includes(pattern)) {
      return code
    }
  }
  return null
}
