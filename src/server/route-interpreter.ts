import { Effect, Schema } from "effect"
import { ErrorCode, createApiError } from "../shared/error-codes.ts"

export class HttpRouteError extends Schema.TaggedError<HttpRouteError>()("HttpRouteError", {
  message: Schema.String,
  code: Schema.Enums(ErrorCode),
  status: Schema.Number,
  details: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  cause: Schema.optional(Schema.Unknown),
}) {}

function toErrorResponse(error: HttpRouteError): Response {
  return new Response(JSON.stringify(createApiError(error.message, error.code, error.details)), {
    status: error.status,
    headers: { "Content-Type": "application/json" },
  })
}

export function httpRouteError(
  message: string,
  code: ErrorCode,
  status: number,
  options?: { details?: Record<string, unknown>; cause?: unknown },
): HttpRouteError {
  return new HttpRouteError({
    message,
    code,
    status,
    details: options?.details,
    cause: options?.cause,
  })
}

export function badRequestError(message: string, code: ErrorCode, details?: Record<string, unknown>): HttpRouteError {
  return httpRouteError(message, code, 400, { details })
}

export function notFoundError(message: string, code: ErrorCode, details?: Record<string, unknown>): HttpRouteError {
  return httpRouteError(message, code, 404, { details })
}

export function conflictError(message: string, code: ErrorCode, details?: Record<string, unknown>): HttpRouteError {
  return httpRouteError(message, code, 409, { details })
}

export function serviceUnavailableError(
  message: string,
  code: ErrorCode,
  details?: Record<string, unknown>,
): HttpRouteError {
  return httpRouteError(message, code, 503, { details })
}

export function internalRouteError(
  message: string,
  code: ErrorCode,
  cause?: unknown,
  details?: Record<string, unknown>,
): HttpRouteError {
  return httpRouteError(message, code, 500, { cause, details })
}

export function runRouteEffect(effect: Effect.Effect<Response, HttpRouteError>): Promise<Response> {
  return Effect.runPromise(
    effect.pipe(
      Effect.catchTag("HttpRouteError", (error) => Effect.succeed(toErrorResponse(error))),
    ),
  )
}
