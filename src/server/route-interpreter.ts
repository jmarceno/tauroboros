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

export function runRouteEffect(effect: Effect.Effect<Response, HttpRouteError>): Promise<Response> {
  return Effect.runPromise(
    effect.pipe(
      Effect.catchTag("HttpRouteError", (error) => Effect.succeed(toErrorResponse(error))),
    ),
  )
}
