import { readFileSync, existsSync, writeFileSync } from "fs"
import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"

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

export function registerContainerRoutes(router: Router, ctx: ServerRouteContext): void {
  router.get("/api/workflow/status", ({ json, db }) => {
    try {
      const hasRunning = db.hasRunningWorkflows()
      return json({ hasRunningWorkflows: hasRunning })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: `Failed to get workflow status: ${message}` }, 500)
    }
  })

  router.get("/api/container/profiles", ({ json }) => {
    try {
      const profilesPath = ctx.getContainerProfilesPath()
      if (!existsSync(profilesPath)) {
        throw new Error(`Container profiles file not found at ${profilesPath}`)
      }
      const raw = readFileSync(profilesPath, "utf-8")
      const data = JSON.parse(raw) as ProfilesFile
      if (!Array.isArray(data.profiles)) {
        throw new Error(`Invalid profiles file: 'profiles' must be an array, got ${typeof data.profiles}`)
      }
      return json({ profiles: data.profiles })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: `Failed to load profiles: ${message}` }, 500)
    }
  })

  router.post("/api/container/profiles", async ({ req, json, broadcast }) => {
    try {
      const body = await req.json()
      const profile: ContainerProfile = {
        id: String(body.id ?? "").trim(),
        name: String(body.name ?? "").trim(),
        description: String(body.description ?? "").trim(),
        image: String(body.image ?? "").trim(),
        dockerfileTemplate: String(body.dockerfileTemplate ?? "").trim(),
      }

      if (!profile.id || !profile.name || !profile.dockerfileTemplate) {
        return json({ error: "Profile id, name, and dockerfileTemplate are required" }, 400)
      }

      if (!/^[a-z0-9-]+$/.test(profile.id)) {
        return json({ error: "Profile ID must be lowercase alphanumeric with hyphens only" }, 400)
      }

      const profilesPath = ctx.getContainerProfilesPath()
      let data: ProfilesFile

      if (existsSync(profilesPath)) {
        const raw = readFileSync(profilesPath, "utf-8")
        data = JSON.parse(raw) as ProfilesFile
      } else {
        data = { profiles: [] }
      }

      const existingIndex = data.profiles.findIndex((p) => p.id === profile.id)
      if (existingIndex >= 0) {
        return json({ error: `Profile '${profile.id}' already exists. Use a different ID.` }, 409)
      }

      data.profiles.push(profile)
      writeFileSync(profilesPath, JSON.stringify(data, null, 2), "utf-8")

      broadcast({ type: "container_profile_created", payload: profile })
      return json({ ok: true, profile })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: `Failed to save profile: ${message}` }, 500)
    }
  })

  router.get("/api/container/status", ({ json, db }) => {
    if (!ctx.settings) {
      throw new Error("Server settings not loaded: cannot determine container status")
    }
    if (!ctx.settings.workflow) {
      throw new Error("Workflow settings not configured: cannot determine container status")
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
  })

  router.post("/api/container/validate", async ({ req, json }) => {
    try {
      if (!ctx.imageManager) {
        return json({ error: "Container image manager not available" }, 503)
      }

      const body = await req.json()
      const packages = Array.isArray(body.packages) ? body.packages : []

      if (packages.length === 0) {
        return json({ valid: [], invalid: [], suggestions: {} })
      }

      const result = await ctx.imageManager.validatePackages(packages)
      return json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: `Validation failed: ${message}` }, 500)
    }
  })

  router.get("/api/container/dockerfile/:profileId", ({ params, json }) => {
    try {
      const profilesPath = ctx.getContainerProfilesPath()
      if (!existsSync(profilesPath)) {
        return json({ error: "Profiles not found" }, 404)
      }

      const raw = readFileSync(profilesPath, "utf-8")
      const data = JSON.parse(raw) as ProfilesFile
      const profile = data.profiles.find((p) => p.id === params.profileId)

      if (!profile) {
        return json({ error: `Profile '${params.profileId}' not found` }, 404)
      }

      return json({
        dockerfile: profile.dockerfileTemplate,
        image: profile.image,
        profile: { id: profile.id, name: profile.name, description: profile.description },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: `Failed to get Dockerfile: ${message}` }, 500)
    }
  })

  router.post("/api/container/build", async ({ req, json, broadcast, db }) => {
    try {
      if (!ctx.imageManager) {
        return json({ error: "Container image manager not available" }, 503)
      }

      if (db.hasRunningWorkflows()) {
        return json(
          { error: "Cannot build image while workflow is running. Please stop all workflows first." },
          409,
        )
      }

      const body = await req.json()
      const profileId = body.profileId ?? "default"
      const customDockerfile = body.dockerfile ? String(body.dockerfile) : null

      const profilesPath = ctx.getContainerProfilesPath()
      let dockerfile: string
      let imageTag: string = body.imageTag ?? `pi-agent:custom-${Date.now()}`

      if (customDockerfile) {
        dockerfile = customDockerfile
      } else if (existsSync(profilesPath)) {
        const raw = readFileSync(profilesPath, "utf-8")
        const data = JSON.parse(raw) as ProfilesFile
        const profile = data.profiles.find((p) => p.id === profileId)

        if (!profile) {
          return json({ error: `Profile '${profileId}' not found` }, 404)
        }

        dockerfile = profile.dockerfileTemplate
        if (!body.imageTag && profile.image) {
          imageTag = `pi-agent:${profile.id}-${Date.now()}`
        }
      } else {
        return json({ error: "No profiles found and no custom Dockerfile provided" }, 400)
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

      ctx.imageManager
        .buildFromDockerfileContent(dockerfile, imageTag, {
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

            if (status.status === "success") {
              if (ctx.settings?.workflow?.container) {
                ctx.settings.workflow.container.image = imageTag
              }
            }

            broadcast({
              type: "container_build_completed",
              payload: { buildId, status: finalStatus, logs: status.logs, imageTag, error: status.errorMessage },
            })
          },
          isCancelled: () => false,
        })
        .then((result) => {
          if (result.logs.length > 0) {
            db.updateContainerBuild(buildId, {
              logs: result.logs.join("\n"),
              errorMessage: result.errorMessage ?? undefined,
            })
          }
        })
        .catch((error) => {
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
        })

      return json({ buildId, status: "running", imageTag, profileId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: `Failed to start build: ${message}` }, 500)
    }
  })

  router.get("/api/container/build-status", ({ url, json, db }) => {
    try {
      const limit = Number(url.searchParams.get("limit") ?? 10)
      const builds = db.getContainerBuilds(limit)
      return json({ builds })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: `Failed to get builds: ${message}` }, 500)
    }
  })

  router.post("/api/container/build/cancel", async ({ req, json, broadcast, db }) => {
    try {
      const body = await req.json()
      const buildId = body.buildId

      if (!buildId) {
        return json({ error: "buildId is required" }, 400)
      }

      db.updateContainerBuild(buildId, {
        status: "cancelled",
        completedAt: Math.floor(Date.now() / 1000),
      })

      broadcast({ type: "container_build_cancelled", payload: { buildId } })
      return json({ ok: true, buildId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: `Failed to cancel build: ${message}` }, 500)
    }
  })

  router.get("/api/container/images", async ({ json, db }) => {
    try {
      if (ctx.settings?.workflow?.container?.enabled === false) {
        return json({ images: [] })
      }

      const builds = db.getContainerBuilds(100)
      const buildImages = builds
        .filter((b) => b.imageTag && b.status === "success")
        .map((b) => {
          if (!b.completedAt && !b.startedAt) {
            throw new Error(`Build ${b.id} has no completedAt or startedAt timestamp`)
          }
          const createdAt = b.completedAt ?? b.startedAt
          if (!createdAt) {
            throw new Error(
              `Build ${b.id} has invalid timestamps: completedAt=${b.completedAt}, startedAt=${b.startedAt}`,
            )
          }
          return {
            tag: b.imageTag!,
            createdAt,
            source: "build" as const,
          }
        })

      const podmanImages = await ctx.getPodmanImages()

      const podmanImagesMap = new Map<string, { tag: string; createdAt: number; size: string }>()
      for (const img of podmanImages) {
        podmanImagesMap.set(img.tag, img)
      }

      const allImages = new Map<
        string,
        { tag: string; createdAt: number; source: "build" | "podman"; size?: string }
      >()

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
          if (currentCount === undefined) {
            imageUsage[task.containerImage] = 1
          } else {
            imageUsage[task.containerImage] = currentCount + 1
          }
        }
      }

      const result = Array.from(allImages.values()).map((img) => ({
        ...img,
        inUseByTasks: imageUsage[img.tag] ?? 0,
      }))

      return json({ images: result.sort((a, b) => b.createdAt - a.createdAt) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("[API /container/images] Error:", message)
      return json({ error: `Failed to get container images: ${message}` }, 500)
    }
  })

  router.post("/api/container/validate-image", async ({ req, json, db }) => {
    try {
      const body = await req.json()
      const tag = String(body?.tag ?? "")

      if (!tag) {
        return json({ error: "tag is required" }, 400)
      }

      let availableInPodman = false
      if (ctx.settings?.workflow?.container?.enabled !== false) {
        availableInPodman = await ctx.validateContainerImage(tag)
      }

      const builds = db.getContainerBuilds(100)
      const existsInBuilds = builds.some((b) => b.imageTag === tag && b.status === "success")

      return json({
        exists: existsInBuilds || availableInPodman,
        tag,
        availableInPodman,
        availableInBuilds: existsInBuilds,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: `Validation failed: ${message}` }, 500)
    }
  })

  router.delete("/api/container/images/:tag", async ({ params, json, db }) => {
    try {
      const tag = decodeURIComponent(params.tag)

      if (!tag) {
        return json({ error: "tag is required" }, 400)
      }

      const tasks = db.getTasks()
      const tasksUsing = tasks.filter((t) => t.containerImage === tag && t.status !== "done")

      if (tasksUsing.length > 0) {
        return json(
          {
            success: false,
            message: `Cannot delete image: used by ${tasksUsing.length} non-done task(s)`,
            tasksUsing: tasksUsing.map((t) => ({ id: t.id, name: t.name })),
          },
          400,
        )
      }

      const allImages = await ctx.getPodmanImages()
      const piAgentImages = allImages.filter((img) => img.tag.includes("pi-agent"))

      if (piAgentImages.length <= 1) {
        return json(
          {
            success: false,
            message: "Cannot delete the last available pi-agent image",
          },
          400,
        )
      }

      if (!ctx.containerManager) {
        return json({ success: false, message: "Container manager not available" }, 503)
      }

      const result = await ctx.containerManager.deleteImage(tag)

      if (!result.success) {
        return json({ success: false, message: `Failed to delete image: ${result.error}` }, 500)
      }

      return json({ success: true, message: `Image ${tag} deleted successfully` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: `Failed to delete image: ${message}` }, 500)
    }
  })
}
