import { readFileSync, existsSync, writeFileSync } from "fs"
import { Effect } from "effect"
import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import { ErrorCode, createApiError } from "../../shared/error-codes.ts"
import {
  badRequestError,
  conflictError,
  internalRouteError,
  notFoundError,
  serviceUnavailableError,
} from "../route-interpreter.ts"

interface ContainerProfile {
  id: string
  name: string
  description: string
  image: string
  dockerfileTemplate: string
}

interface ProfilesFile {
  profiles: ContainerProfile[]
}

function loadProfilesFile(ctx: ServerRouteContext): ProfilesFile {
  const profilesPath = ctx.getContainerProfilesPath()
  if (!existsSync(profilesPath)) {
    throw notFoundError(`Container profiles file not found at ${profilesPath}`, ErrorCode.PROFILE_NOT_FOUND)
  }
  const raw = readFileSync(profilesPath, "utf-8")
  const data = JSON.parse(raw) as ProfilesFile
  if (!Array.isArray(data.profiles)) {
    throw badRequestError(`Invalid profiles file: 'profiles' must be an array, got ${typeof data.profiles}`, ErrorCode.INVALID_REQUEST_BODY)
  }
  return data
}

export function registerContainerRoutes(router: Router, ctx: ServerRouteContext): void {
  router.get("/api/workflow/status", ({ json, db }) => Effect.sync(() => json({ hasRunningWorkflows: db.hasRunningWorkflows() })))

  router.get("/api/container/profiles", ({ json }) =>
    Effect.try({
      try: () => loadProfilesFile(ctx),
      catch: (error) =>
        error && typeof error === "object" && "_tag" in error
          ? error as ReturnType<typeof notFoundError>
          : internalRouteError(`Failed to load profiles: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.CONTAINER_OPERATION_FAILED, error),
    }).pipe(Effect.map((data) => json({ profiles: data.profiles }))),
  )

  router.post("/api/container/profiles", ({ req, json, broadcast }) =>
    Effect.gen(function* () {
      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (error) => badRequestError(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.INVALID_JSON_BODY),
      })) as Record<string, unknown>
      const profile: ContainerProfile = {
        id: String(body.id ?? "").trim(),
        name: String(body.name ?? "").trim(),
        description: String(body.description ?? "").trim(),
        image: String(body.image ?? "").trim(),
        dockerfileTemplate: String(body.dockerfileTemplate ?? "").trim(),
      }

      if (!profile.id || !profile.name || !profile.dockerfileTemplate) {
        return json(createApiError("Profile id, name, and dockerfileTemplate are required", ErrorCode.INVALID_REQUEST_BODY), 400)
      }

      if (!/^[a-z0-9-]+$/.test(profile.id)) {
        return json(createApiError("Profile ID must be lowercase alphanumeric with hyphens only", ErrorCode.INVALID_REQUEST_BODY), 400)
      }

      const savedProfile = yield* Effect.tryPromise({
        try: async () => {
          const profilesPath = ctx.getContainerProfilesPath()
          let data: ProfilesFile

          if (existsSync(profilesPath)) {
            const raw = readFileSync(profilesPath, "utf-8")
            data = await new Response(raw).json() as ProfilesFile
          } else {
            data = { profiles: [] }
          }

          const existingIndex = data.profiles.findIndex((p) => p.id === profile.id)
          if (existingIndex >= 0) {
            throw conflictError(`Profile '${profile.id}' already exists. Use a different ID.`, ErrorCode.CONTAINER_OPERATION_FAILED)
          }

          data.profiles.push(profile)
          writeFileSync(profilesPath, `${await Response.json(data).text()}\n`, "utf-8")
          return profile
        },
        catch: (error) =>
          error && typeof error === "object" && "_tag" in error
            ? error as ReturnType<typeof conflictError>
            : internalRouteError(`Failed to save profile: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.CONTAINER_OPERATION_FAILED, error),
      })

      broadcast({ type: "container_profile_created", payload: savedProfile })
      return json({ ok: true, profile: savedProfile })
    }),
  )

  router.get("/api/container/status", ({ json, db }) =>
    Effect.sync(() => {
      if (!ctx.settings || !ctx.settings.workflow) {
        return json(createApiError("Workflow settings not configured: cannot determine container status", ErrorCode.CONTAINER_OPERATION_FAILED), 500)
      }
      const enabled = ctx.settings.workflow.container?.enabled !== false
      const hasRunning = db.hasRunningWorkflows()
      return json({
        enabled,
        available: ctx.imageManager != null,
        hasRunningWorkflows: hasRunning,
        message: enabled
          ? ctx.imageManager
            ? "Container mode active (default)"
            : "Container mode enabled but image manager failed to initialize"
          : "Container mode is explicitly disabled. Native mode is active - tasks run directly on the host.",
      })
    }),
  )

  router.post("/api/container/validate", ({ req, json }) =>
    Effect.gen(function* () {
      if (!ctx.imageManager) {
        return json(createApiError("Container image manager not available", ErrorCode.SERVICE_UNAVAILABLE), 503)
      }

      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (error) => badRequestError(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.INVALID_JSON_BODY),
      })) as Record<string, unknown>
      const packages = Array.isArray(body.packages) ? body.packages : []

      if (packages.length === 0) {
        return json({ valid: [], invalid: [], suggestions: {} })
      }

      const result = yield* ctx.imageManager.validatePackages(packages).pipe(
        Effect.mapError((error) => internalRouteError(`Validation failed: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.CONTAINER_OPERATION_FAILED, error)),
      )
      return json(result)
    }),
  )

  router.get("/api/container/dockerfile/:profileId", ({ params, json }) =>
    Effect.try({
      try: () => {
        const data = loadProfilesFile(ctx)
        const profile = data.profiles.find((p) => p.id === params.profileId)

        if (!profile) {
          throw notFoundError(`Profile '${params.profileId}' not found`, ErrorCode.PROFILE_NOT_FOUND)
        }

        return {
          dockerfile: profile.dockerfileTemplate,
          image: profile.image,
          profile: { id: profile.id, name: profile.name, description: profile.description },
        }
      },
      catch: (error) =>
        error && typeof error === "object" && "_tag" in error
          ? error as ReturnType<typeof notFoundError>
          : internalRouteError(`Failed to get Dockerfile: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.CONTAINER_OPERATION_FAILED, error),
    }).pipe(Effect.map((result) => json(result))),
  )

  router.post("/api/container/build", ({ req, json, broadcast, db }) =>
    Effect.gen(function* () {
        if (!ctx.imageManager) {
          return yield* Effect.fail(serviceUnavailableError("Container image manager not available", ErrorCode.SERVICE_UNAVAILABLE))
        }

        if (db.hasRunningWorkflows()) {
          return yield* Effect.fail(conflictError("Cannot build image while workflow is running. Please stop all workflows first.", ErrorCode.CONTAINER_OPERATION_FAILED))
        }

        const body = yield* Effect.tryPromise({
          try: () => req.json() as Promise<Record<string, unknown>>,
          catch: (error) => badRequestError(`Invalid build request body: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.INVALID_REQUEST_BODY),
        })

        const profileId = typeof body.profileId === "string" && body.profileId.trim() ? body.profileId : "default"
        const customDockerfile = typeof body.dockerfile === "string" && body.dockerfile.trim() ? body.dockerfile : null
        const requestedImageTag = typeof body.imageTag === "string" && body.imageTag.trim() ? body.imageTag : null

        const profilesPath = ctx.getContainerProfilesPath()
        let dockerfile: string
        let imageTag = requestedImageTag ?? `pi-agent:custom-${Date.now()}`

        if (customDockerfile) {
          dockerfile = customDockerfile
        } else if (existsSync(profilesPath)) {
          const raw = readFileSync(profilesPath, "utf-8")
          const data = JSON.parse(raw) as ProfilesFile
          const profile = data.profiles.find((p) => p.id === profileId)

          if (!profile) {
            return yield* Effect.fail(notFoundError(`Profile '${profileId}' not found`, ErrorCode.PROFILE_NOT_FOUND))
          }

          dockerfile = profile.dockerfileTemplate
          if (!requestedImageTag && profile.image) {
            imageTag = `pi-agent:${profile.id}-${Date.now()}`
          }
        } else {
          return yield* Effect.fail(badRequestError("No profiles found and no custom Dockerfile provided", ErrorCode.INVALID_REQUEST_BODY))
        }

        const buildId = db.createContainerBuild({
          status: "running",
          startedAt: Math.floor(Date.now() / 1000),
          packagesHash: ctx.hashPackages([]),
          imageTag,
        })

        broadcast({ type: "container_build_started", payload: { buildId, imageTag, status: "running", profileId } })

        const logs: string[] = []
        let lastDbUpdate = Date.now()

        const buildEffect = ctx.imageManager.buildFromDockerfileContent(dockerfile, imageTag, {
          onLog: (line) => {
            logs.push(line)
            const now = Date.now()
            if (now - lastDbUpdate > 5000 || logs.length % 50 === 0) {
              db.updateContainerBuild(buildId, { logs: logs.join("\n") })
              lastDbUpdate = now
            }
            if (logs.length % 10 === 0) {
              broadcast({
                type: "container_build_progress",
                payload: { buildId, logs: logs.slice(-10), status: "running" },
              })
            }
          },
          onStatus: (status) => {
            const finalStatus =
              status.status === "success" ? "success" : status.status === "failed" ? "failed" : "running"
            const allLogs = status.logs.join("\n")

            db.updateContainerBuild(buildId, {
              status: finalStatus,
              completedAt: Math.floor(Date.now() / 1000),
              logs: allLogs,
              errorMessage: status.errorMessage ?? undefined,
            })

            if (status.status === "success" && ctx.settings?.workflow?.container) {
              ctx.settings.workflow.container.image = imageTag
            }

            broadcast({
              type: "container_build_completed",
              payload: { buildId, status: finalStatus, logs: status.logs, imageTag, error: status.errorMessage },
            })
          },
          isCancelled: () => false,
        }).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if (result.logs.length > 0) {
                db.updateContainerBuild(buildId, {
                  logs: result.logs.join("\n"),
                  errorMessage: result.errorMessage ?? undefined,
                })
              }
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              const message = error instanceof Error ? error.message : String(error)
              db.updateContainerBuild(buildId, {
                status: "failed",
                completedAt: Math.floor(Date.now() / 1000),
                errorMessage: message,
                logs: logs.join("\n"),
              })
              broadcast({
                type: "container_build_completed",
                payload: { buildId, status: "failed", logs, imageTag, error: message },
              })
            }),
          ),
          Effect.asVoid,
        )

        yield* buildEffect.pipe(Effect.forkDaemon)

        return json({ buildId, status: "running", imageTag, profileId })
      }),
  )

  router.get("/api/container/build-status", ({ url, json, db }) =>
    Effect.sync(() => {
      const limit = Number(url.searchParams.get("limit") ?? 10)
      const builds = db.getContainerBuilds(limit)
      return json({ builds })
    }),
  )

  router.post("/api/container/build/cancel", ({ req, json, broadcast, db }) =>
    Effect.gen(function* () {
      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (error) => badRequestError(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.INVALID_JSON_BODY),
      })) as Record<string, unknown>
      const buildId = body.buildId

      if (!buildId) {
        return json(createApiError("buildId is required", ErrorCode.INVALID_REQUEST_BODY), 400)
      }

      db.updateContainerBuild(String(buildId), {
        status: "cancelled",
        completedAt: Math.floor(Date.now() / 1000),
      })

      broadcast({ type: "container_build_cancelled", payload: { buildId } })
      return json({ ok: true, buildId })
    }),
  )

  router.get("/api/container/images", ({ json, db }) =>
    Effect.gen(function* () {
      if (ctx.settings?.workflow?.container?.enabled === false) {
        return json({ images: [] })
      }

        const builds = db.getContainerBuilds(100)
        const buildImages = builds
          .filter((b) => b.imageTag && b.status === "success")
          .map((b) => {
            if (!b.completedAt && !b.startedAt) {
              throw internalRouteError(`Build ${b.id} has no completedAt or startedAt timestamp`, ErrorCode.CONTAINER_OPERATION_FAILED)
            }
            const createdAt = b.completedAt ?? b.startedAt
            if (!createdAt) {
              throw internalRouteError(`Build ${b.id} has invalid timestamps: completedAt=${b.completedAt}, startedAt=${b.startedAt}`, ErrorCode.CONTAINER_OPERATION_FAILED)
            }
            return {
              tag: b.imageTag!,
              createdAt,
              source: "build" as const,
            }
          })

        const podmanImages = yield* ctx.getPodmanImages().pipe(
          Effect.mapError((error) => internalRouteError(`Failed to get container images: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.CONTAINER_OPERATION_FAILED, error)),
        )
        const podmanImagesMap = new Map<string, { tag: string; createdAt: number; size: string }>()
        for (const img of podmanImages) {
          podmanImagesMap.set(img.tag, img)
        }

        const allImages = new Map<string, { tag: string; createdAt: number; source: "build" | "podman"; size?: string }>()
        for (const img of buildImages) {
          const podmanImg = podmanImagesMap.get(img.tag)
          allImages.set(img.tag, { ...img, size: podmanImg?.size })
        }
        for (const img of podmanImages) {
          if (!allImages.has(img.tag)) {
            allImages.set(img.tag, { ...img, source: "podman" })
          }
        }

        const tasks = db.getTasks()
        const imageUsage: Record<string, number> = {}
        for (const task of tasks) {
          if (task.containerImage && task.status !== "done") {
            const currentCount = imageUsage[task.containerImage]
            imageUsage[task.containerImage] = currentCount === undefined ? 1 : currentCount + 1
          }
        }

        const result = Array.from(allImages.values()).map((img) => ({
          ...img,
          inUseByTasks: imageUsage[img.tag] ?? 0,
        }))

        return json({ images: result.sort((a, b) => b.createdAt - a.createdAt) })
      }).pipe(
        Effect.catchAll((error) =>
          Effect.fail(
            error && typeof error === "object" && "_tag" in error
              ? error as ReturnType<typeof internalRouteError>
              : internalRouteError(`Failed to get container images: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.CONTAINER_OPERATION_FAILED, error),
          )
        ),
      ),
  )

  router.post("/api/container/validate-image", ({ req, json, db }) =>
    Effect.gen(function* () {
      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (error) => badRequestError(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.INVALID_JSON_BODY),
      })) as Record<string, unknown>
      const tag = String(body?.tag ?? "")

      if (!tag) {
        return json(createApiError("tag is required", ErrorCode.INVALID_REQUEST_BODY), 400)
      }

        let availableInPodman = false
        if (ctx.settings?.workflow?.container?.enabled !== false) {
          availableInPodman = yield* ctx.validateContainerImage(tag).pipe(
            Effect.mapError((error) => internalRouteError(`Validation failed: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.CONTAINER_OPERATION_FAILED, error)),
          )
        }

        const builds = db.getContainerBuilds(100)
        const existsInBuilds = builds.some((b) => b.imageTag === tag && b.status === "success")

        return json({
          exists: existsInBuilds || availableInPodman,
          tag,
          availableInPodman,
          availableInBuilds: existsInBuilds,
        })
      }),
  )

  router.delete("/api/container/images/:tag", ({ params, json, db }) =>
    Effect.gen(function* () {
      const tag = decodeURIComponent(params.tag)

      if (!tag) {
        return json(createApiError("tag is required", ErrorCode.INVALID_REQUEST_BODY), 400)
      }

      const tasks = db.getTasks()
      const tasksUsing = tasks.filter((t) => t.containerImage === tag && t.status !== "done")
      if (tasksUsing.length > 0) {
        return json(
          createApiError(`Cannot delete image: used by ${tasksUsing.length} non-done task(s)`, ErrorCode.CONTAINER_OPERATION_FAILED, {
            tasksUsing: tasksUsing.map((t) => ({ id: t.id, name: t.name })),
          }),
          400,
        )
      }

      if (!ctx.containerManager) {
        return json(createApiError("Container manager not available", ErrorCode.SERVICE_UNAVAILABLE), 503)
      }

        const allImages = yield* ctx.getPodmanImages().pipe(
          Effect.mapError((error) => internalRouteError(`Failed to delete image: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.CONTAINER_OPERATION_FAILED, error)),
        )
        const piAgentImages = allImages.filter((img) => img.tag.includes("pi-agent"))
        if (piAgentImages.length <= 1) {
          return yield* Effect.fail(badRequestError("Cannot delete the last available pi-agent image", ErrorCode.CONTAINER_OPERATION_FAILED))
        }

        const result = yield* ctx.containerManager.deleteImage(tag).pipe(
          Effect.mapError((error) => internalRouteError(`Failed to delete image: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.CONTAINER_OPERATION_FAILED, error)),
        )
        if (!result.success) {
          return yield* Effect.fail(internalRouteError(`Failed to delete image: ${result.error}`, ErrorCode.CONTAINER_OPERATION_FAILED))
        }

        return json({ success: true, message: `Image ${tag} deleted successfully` })
      }),
  )
}
