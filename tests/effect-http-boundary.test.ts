import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { ErrorCode } from "../src/shared/error-codes.ts"
import {
  HttpRouteError,
  badRequestError,
  runRouteEffect,
} from "../src/server/route-interpreter.ts"

describe("route interpreter boundary", () => {
  it("passes through successful responses", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })

    const result = await runRouteEffect(Effect.succeed(response))

    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ ok: true })
  })

  it("translates HttpRouteError into standardized API response", async () => {
    const result = await runRouteEffect(
      Effect.fail(
        badRequestError("Invalid payload", ErrorCode.INVALID_REQUEST_BODY, {
          field: "taskId",
        }),
      ),
    )

    expect(result.status).toBe(400)
    expect(result.headers.get("Content-Type")).toContain("application/json")

    const body = await result.json() as {
      error: string
      code: string
      details?: Record<string, unknown>
    }

    expect(body.error).toBe("Invalid payload")
    expect(body.code).toBe(ErrorCode.INVALID_REQUEST_BODY)
    expect(body.details).toEqual({ field: "taskId" })
  })

  it("preserves explicit HttpRouteError status and code", async () => {
    const customError = new HttpRouteError({
      message: "Service degraded",
      code: ErrorCode.SERVICE_UNAVAILABLE,
      status: 503,
    })

    const result = await runRouteEffect(Effect.fail(customError))
    const body = await result.json() as { error: string; code: string }

    expect(result.status).toBe(503)
    expect(body.error).toBe("Service degraded")
    expect(body.code).toBe(ErrorCode.SERVICE_UNAVAILABLE)
  })
})
