export enum ErrorCode {
  PLANNING_SESSION_NOT_ACTIVE = 'PLANNING_SESSION_NOT_ACTIVE',
  PLANNING_SESSION_NOT_FOUND = 'PLANNING_SESSION_NOT_FOUND',
  PLANNING_SESSION_ALREADY_ACTIVE = 'PLANNING_SESSION_ALREADY_ACTIVE',
  PLANNING_SESSION_CREATE_FAILED = 'PLANNING_SESSION_CREATE_FAILED',
  PLANNING_SESSION_CLOSE_FAILED = 'PLANNING_SESSION_CLOSE_FAILED',
  PLANNING_SESSION_RECONNECT_FAILED = 'PLANNING_SESSION_RECONNECT_FAILED',
  PLANNING_SESSION_STOP_FAILED = 'PLANNING_SESSION_STOP_FAILED',
  MESSAGE_SEND_FAILED = 'MESSAGE_SEND_FAILED',
  MESSAGE_RETRY_FAILED = 'MESSAGE_RETRY_FAILED',
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
  TASK_ALREADY_IN_GROUP = 'TASK_ALREADY_IN_GROUP',
  EXTERNAL_DEPENDENCIES_BLOCKED = 'EXTERNAL_DEPENDENCIES_BLOCKED',
  TASK_BLOCKED = 'TASK_BLOCKED',
  INVALID_CONTAINER_IMAGES = 'INVALID_CONTAINER_IMAGES',
  CONTAINER_IMAGE_NOT_FOUND = 'CONTAINER_IMAGE_NOT_FOUND',
  TASK_ALREADY_EXECUTING = 'TASK_ALREADY_EXECUTING',
  ORCHESTRATOR_OPERATION_FAILED = 'ORCHESTRATOR_OPERATION_FAILED',
  BUBBLEWRAP_NOT_AVAILABLE = 'BUBBLEWRAP_NOT_AVAILABLE',
  INVALID_PATH_GRANT = 'INVALID_PATH_GRANT',
}

export interface ApiError {
  error: string
  code?: ErrorCode
  details?: Record<string, unknown>
}

export function isErrorCode(error: unknown, code: ErrorCode): boolean {
  if (!error) return false
  if (typeof error === 'object' && error !== null) {
    const err = error as { code?: string; error?: string }
    if (err.code === code) return true
    if (err.error?.includes(code)) return true
  }
  if (error instanceof Error) return error.message.includes(code)
  if (typeof error === 'string') return error.includes(code)
  return false
}

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

export function createApiError(message: string, code: ErrorCode, details?: Record<string, unknown>): ApiError {
  return { error: message, code, details }
}

const LEGACY_ERROR_PATTERNS: Record<string, ErrorCode> = {
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

export function detectErrorCodeFromMessage(message: string): ErrorCode | null {
  for (const [pattern, code] of Object.entries(LEGACY_ERROR_PATTERNS)) {
    if (message.includes(pattern)) return code
  }
  return null
}
