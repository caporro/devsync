import "./env.js"
import path from "node:path"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import fastifyMultipart from "@fastify/multipart"
import fastifyStatic from "@fastify/static"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import Fastify from "fastify"
import { registerAgentRoutes } from "./agent-routes.js"
import { createAuth } from "./auth.js"
import { ensureVaultGit, gitPull, gitPush } from "./git.js"
import { createDevsyncMcpServer } from "./mcp-server.js"
import {
  createMcpTokenForUser,
  deleteMcpTokenForUser,
  listMcpTokensForUser,
  verifyMcpToken,
} from "./mcp-tokens.js"
import { checkRateLimit, recordRateLimitHit, resetRateLimit } from "./rate-limit.js"
import { emitAutomationEvent, startAutomationScheduler } from "./automation-triggers.js"
import { listMentionInbox, markInboxRead } from "./mentions.js"
import { listSystemLogEvents } from "./system-log.js"
import {
  addLinkArtifact,
  addExcalidrawArtifact,
  addLog,
  addTextArtifact,
  createTask,
  createProject,
  createDocFileStream,
  createProjectFileStream,
  dataDir,
  deleteArtifact,
  deleteTask,
  ensureDataDir,
  getActivityLog,
  getDocFolder,
  getPlanningGantt,
  getProject,
  listNewsEntries,
  listDocs,
  listTasks,
  listProjects,
  readDocFile,
  readProjectFile,
  saveUpload,
  updateArtifactIndex,
  updateExcalidrawArtifact,
  updateGeneratedMarkdown,
  updateTaskIndex,
  updateMarkdownArtifact,
  updatePlanningGantt,
  updateTask,
  updateProject,
  toggleTask,
  vaultDir,
  vaultName,
} from "./storage.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : true })
const port = Number(process.env.PORT ?? 4000)
const host = process.env.HOST ?? "127.0.0.1"
const webDist = path.resolve(
  process.env.DEVSYNC_WEB_DIST ?? path.join(__dirname, "..", "..", "web", "dist")
)
const apiToken = process.env.DEVSYNC_API_TOKEN
const auth = createAuth()
const INLINE_DOWNLOAD_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".pdf", ".png", ".webp"])
const RATE_LIMIT_WINDOW_MS = Number(process.env.DEVSYNC_RATE_LIMIT_WINDOW_MS ?? 10 * 60 * 1000)
const LOGIN_USER_LIMIT = Number(process.env.DEVSYNC_LOGIN_USER_LIMIT ?? 8)
const LOGIN_IP_LIMIT = Number(process.env.DEVSYNC_LOGIN_IP_LIMIT ?? 30)
const MCP_AUTH_LIMIT = Number(process.env.DEVSYNC_MCP_AUTH_LIMIT ?? 60)
const MCP_TOKEN_CREATE_LIMIT = Number(process.env.DEVSYNC_MCP_TOKEN_CREATE_LIMIT ?? 10)

await ensureDataDir()

function hasValidApiToken(request) {
  const authorization = request.headers.authorization ?? ""
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : request.headers["x-devsync-token"]

  return Boolean(apiToken && token === apiToken)
}

function bearerToken(request) {
  const authorization = request.headers.authorization ?? ""
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : ""
}

function requestIp(request) {
  return String(request.ip ?? request.socket?.remoteAddress ?? request.raw?.socket?.remoteAddress ?? "unknown")
}

function rateLimitError(message, retryAfter) {
  return Object.assign(new Error(message), {
    statusCode: 429,
    retryAfterSeconds: retryAfter,
  })
}

function firstBlockedRateLimit(checks) {
  return checks.find((check) => !check.allowed) ?? null
}

function applyRateLimitReply(reply, blocked) {
  reply
    .code(429)
    .header("Retry-After", String(blocked.retryAfterSeconds))
    .send({ error: "Too many attempts. Try again later." })
}

async function currentMcpUser(request) {
  if (hasValidApiToken(request)) {
    return { username: "api-token", email: "api-token", name: "API token", authMode: "api-token" }
  }

  if (!auth.isEnabled && !apiToken) {
    return auth.currentUser(request)
  }

  const mcpRateKey = `mcp-auth:${requestIp(request)}`
  const mcpRate = checkRateLimit(mcpRateKey, {
    limit: MCP_AUTH_LIMIT,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })

  if (!mcpRate.allowed) {
    throw rateLimitError("Too many MCP auth attempts", mcpRate.retryAfterSeconds)
  }

  const tokenUser = await verifyMcpToken(bearerToken(request))
  if (tokenUser) {
    resetRateLimit(mcpRateKey)
    return tokenUser
  }

  recordRateLimitHit(mcpRateKey, {
    limit: MCP_AUTH_LIMIT,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  return null
}

function isPublicApiPath(url) {
  return ["/api/health", "/api/auth/me", "/api/auth/login", "/api/auth/logout"].includes(url.split("?")[0])
}

function requireAuth(request, reply, done) {
  if (isPublicApiPath(request.url)) {
    done()
    return
  }

  if (hasValidApiToken(request)) {
    done()
    return
  }

  if (!auth.isEnabled && !apiToken) {
    done()
    return
  }

  if (auth.currentUser(request)) {
    done()
    return
  }

  reply.code(401).send({ error: "Unauthorized" })
}

function sendError(reply, error) {
  const isMissingFile = ["ENOENT", "ENOTDIR"].includes(error.code)
  const statusCode = error.statusCode ?? (isMissingFile ? 404 : 500)

  if (statusCode === 429 && error.retryAfterSeconds) {
    reply.header("Retry-After", String(error.retryAfterSeconds))
  }

  reply.code(statusCode).send({
    error: statusCode === 500 ? "Internal server error" : isMissingFile ? "File not found" : error.message,
  })
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()

  const types = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".excalidraw": "application/vnd.excalidraw+json; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
  }

  return types[ext] ?? "application/octet-stream"
}

function isSafeInlinePath(filePath) {
  return INLINE_DOWNLOAD_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function sanitizeDownloadFilename(filePath) {
  const fileName = path.basename(filePath).replace(/[\r\n"\\]/g, "").trim()
  return fileName || "file"
}

function withDownloadSecurityHeaders(reply, relativePath, isInline) {
  return reply
    .header("Content-Disposition", `${isInline ? "inline" : "attachment"}; filename="${sanitizeDownloadFilename(relativePath)}"`)
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY")
    .header("Cross-Origin-Resource-Policy", "same-origin")
    .header("Referrer-Policy", "no-referrer")
}

function assigneeIdentities(user) {
  return new Set(
    [user?.name, user?.email, user?.username]
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter(Boolean)
  )
}

function matchesAssignee(owner, identities) {
  const value = String(owner ?? "").trim().toLowerCase()
  return Boolean(value && identities.has(value))
}

await ensureDataDir()

if (process.env.NODE_ENV !== "test") {
  const gitBootstrap = await ensureVaultGit()
  if (!gitBootstrap.ok) {
    app.log.warn({ gitBootstrap }, "vault git bootstrap failed")
  }

  startAutomationScheduler(app.log)
}

app.register(fastifyMultipart, {
  limits: {
    fileSize: Number(process.env.DEVSYNC_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024),
  },
})

app.addHook("preHandler", (request, reply, done) => {
  if (request.url.startsWith("/api/")) {
    requireAuth(request, reply, done)
    return
  }

  done()
})

app.get("/api/health", async () => ({
  ok: true,
  authMode: auth.mode,
}))

app.route({
  method: ["GET", "POST", "DELETE"],
  url: "/mcp",
  handler: async (request, reply) => {
    let mcpUser

    try {
      mcpUser = await currentMcpUser(request)
    } catch (error) {
      sendError(reply, error)
      return
    }

    if (!mcpUser) {
      reply.code(401).send({ error: "Unauthorized" })
      return
    }

    const server = createDevsyncMcpServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })

    try {
      await server.connect(transport)
      reply.hijack()
      await transport.handleRequest(request.raw, reply.raw, request.body)
    } catch (error) {
      request.log.error({ error }, "mcp request failed")
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" })
        reply.raw.end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        }))
      }
    } finally {
      await transport.close()
      await server.close()
    }
  },
})

app.get("/api/auth/me", async (request, reply) => {
  const user = auth.currentUser(request)

  if (!user) {
    reply.code(401).send({ authenticated: false, authMode: auth.mode, error: "Unauthorized" })
    return
  }

  reply.send({ authenticated: true, authMode: auth.mode, user })
})

app.get("/api/users", async (_request, reply) => {
  reply.send({ users: auth.users() })
})

app.get("/api/my/tasks", async (request, reply) => {
  try {
    const user = auth.currentUser(request) ?? { name: "team", email: "team", username: "team" }
    const identities = assigneeIdentities(user)
    const projects = await listProjects()
    const groups = await Promise.all(
      projects.map(async (project) => {
        const items = (await listTasks(project.id))
          .filter((item) => matchesAssignee(item.owner, identities))
          .sort((left, right) => {
            if (left.done !== right.done) return left.done ? 1 : -1
            if ((left.deadline || "") !== (right.deadline || "")) {
              return (left.deadline || "9999-12-31").localeCompare(right.deadline || "9999-12-31")
            }
            return right.updatedAt.localeCompare(left.updatedAt)
          })
          .map((item) => ({
            ...item,
            projectId: project.id,
            projectName: project.name,
          }))

        return items.length ? { project, items } : null
      })
    )

    reply.send({ items: groups.filter(Boolean) })
  } catch (error) {
    sendError(reply, error)
  }
})

app.get("/api/my/inbox", async (request, reply) => {
  try {
    const user = auth.currentUser(request) ?? { name: "team", email: "team", username: "team" }
    reply.send(await listMentionInbox(user, { limit: request.query.limit }))
  } catch (error) {
    sendError(reply, error)
  }
})

app.post("/api/my/inbox/read", async (request, reply) => {
  try {
    const user = auth.currentUser(request) ?? { name: "team", email: "team", username: "team" }
    reply.send(await markInboxRead(user, request.body ?? {}))
  } catch (error) {
    sendError(reply, error)
  }
})

app.post("/api/auth/login", async (request, reply) => {
  const body = request.body ?? {}
  const username = String(body.email ?? body.username ?? "").trim()
  const password = String(body.password ?? "")
  const ip = requestIp(request)
  const loginIpKey = `login-ip:${ip}`
  const loginUserKey = `login-user:${ip}:${username.toLowerCase()}`
  const blocked = firstBlockedRateLimit([
    checkRateLimit(loginIpKey, { limit: LOGIN_IP_LIMIT, windowMs: RATE_LIMIT_WINDOW_MS }),
    checkRateLimit(loginUserKey, { limit: LOGIN_USER_LIMIT, windowMs: RATE_LIMIT_WINDOW_MS }),
  ])

  if (blocked) {
    applyRateLimitReply(reply, blocked)
    return
  }

  const user = await auth.login(username, password)

  if (!user) {
    recordRateLimitHit(loginIpKey, { limit: LOGIN_IP_LIMIT, windowMs: RATE_LIMIT_WINDOW_MS })
    recordRateLimitHit(loginUserKey, { limit: LOGIN_USER_LIMIT, windowMs: RATE_LIMIT_WINDOW_MS })
    reply.code(401).send({ error: "Invalid credentials" })
    return
  }

  resetRateLimit(loginIpKey)
  resetRateLimit(loginUserKey)
  auth.setSession(reply, user.email ?? user.username)
  reply.send({ authenticated: true, authMode: auth.mode, user })
})

app.post("/api/auth/logout", async (_request, reply) => {
  auth.logout(reply)
  reply.send({ ok: true })
})

app.get("/api/mcp-tokens", async (request, reply) => {
  try {
    const user = auth.currentUser(request)
    if (!user) {
      reply.code(401).send({ error: "Unauthorized" })
      return
    }

    reply.send({ items: await listMcpTokensForUser(user) })
  } catch (error) {
    sendError(reply, error)
  }
})

app.post("/api/mcp-tokens", async (request, reply) => {
  try {
    const user = auth.currentUser(request)
    if (!user) {
      reply.code(401).send({ error: "Unauthorized" })
      return
    }

    const key = `mcp-token-create:${user.email ?? user.username ?? requestIp(request)}`
    const blocked = checkRateLimit(key, {
      limit: MCP_TOKEN_CREATE_LIMIT,
      windowMs: RATE_LIMIT_WINDOW_MS,
    })

    if (!blocked.allowed) {
      applyRateLimitReply(reply, blocked)
      return
    }

    recordRateLimitHit(key, {
      limit: MCP_TOKEN_CREATE_LIMIT,
      windowMs: RATE_LIMIT_WINDOW_MS,
    })
    reply.send(await createMcpTokenForUser(user, request.body ?? {}))
  } catch (error) {
    sendError(reply, error)
  }
})

app.delete("/api/mcp-tokens/:tokenId", async (request, reply) => {
  try {
    const user = auth.currentUser(request)
    if (!user) {
      reply.code(401).send({ error: "Unauthorized" })
      return
    }

    reply.send(await deleteMcpTokenForUser(user, request.params.tokenId))
  } catch (error) {
    sendError(reply, error)
  }
})

await registerAgentRoutes(app, auth)

app.get("/api/projects", async () => ({
  items: await listProjects(),
}))

app.get("/api/docs", async () => ({
  items: await listDocs(),
}))

app.get("/api/docs/:docId", async (request, reply) => {
  try {
    reply.send(await getDocFolder(request.params.docId))
  } catch (error) {
    sendError(reply, error)
  }
})

app.get("/api/readme", async (request, reply) => {
  try {
    const readmePath = path.join(vaultDir, "README.md")
    reply.type("text/markdown; charset=utf-8").send(await fs.readFile(readmePath, "utf8"))
  } catch (error) {
    sendError(reply, error)
  }
})

app.get("/api/system-log", async (request, reply) => {
  try {
    reply.send(await listSystemLogEvents({ limit: request.query.limit }))
  } catch (error) {
    sendError(reply, error)
  }
})

app.get("/api/news", async (request, reply) => {
  try {
    reply.send({ items: await listNewsEntries() })
  } catch (error) {
    sendError(reply, error)
  }
})

app.get("/api/planning", async (_request, reply) => {
  try {
    reply.send(await getPlanningGantt())
  } catch (error) {
    sendError(reply, error)
  }
})

app.put("/api/planning", async (request, reply) => {
  try {
    reply.send(await updatePlanningGantt(request.body ?? {}))
  } catch (error) {
    sendError(reply, error)
  }
})

app.post("/api/git/pull", async (request, reply) => {
  try {
    reply.send(await gitPull())
  } catch (error) {
    sendError(reply, error)
  }
})

app.post("/api/git/push", async (request, reply) => {
  try {
    reply.send(await gitPush())
  } catch (error) {
    sendError(reply, error)
  }
})

app.post("/api/projects", async (request, reply) => {
  try {
    const project = await createProject(request.body ?? {})
    reply.code(201).send(project)
  } catch (error) {
    sendError(reply, error)
  }
})

app.get("/api/projects/:projectId", async (request, reply) => {
  try {
    reply.send(
      await getProject(request.params.projectId, {
        activityFiles: Number(request.query.activityFiles ?? 2),
      })
    )
  } catch (error) {
    sendError(reply, error)
  }
})

app.get("/api/projects/:projectId/activity", async (request, reply) => {
  try {
    reply.send(
      await getActivityLog(request.params.projectId, {
        files: Number(request.query.files ?? 1),
        before: request.query.before,
      })
    )
  } catch (error) {
    sendError(reply, error)
  }
})

app.patch("/api/projects/:projectId", async (request, reply) => {
  try {
    reply.send(await updateProject(request.params.projectId, request.body ?? {}))
  } catch (error) {
    sendError(reply, error)
  }
})

app.post("/api/projects/:projectId/logs", async (request, reply) => {
  try {
    const entry = await addLog(request.params.projectId, request.body ?? {})
    reply.code(201).send(entry)

    if (!String(request.body?.author ?? "").startsWith("automation:")) {
      void emitAutomationEvent({
        type: "project_log.added",
        projectId: request.params.projectId,
        payload: { entry },
      }, request.log)
    }
  } catch (error) {
    sendError(reply, error)
  }
})

app.post("/api/projects/:projectId/artifacts/text", async (request, reply) => {
  try {
    const artifact = await addTextArtifact(request.params.projectId, request.body ?? {})
    reply.code(201).send(artifact)
    void emitAutomationEvent({
      type: "artifact.added",
      projectId: request.params.projectId,
      payload: { artifact, artifactKind: "markdown" },
    }, request.log)
  } catch (error) {
    sendError(reply, error)
  }
})

app.post("/api/projects/:projectId/artifacts/link", async (request, reply) => {
  try {
    const artifact = await addLinkArtifact(request.params.projectId, request.body ?? {})
    reply.code(201).send(artifact)
    void emitAutomationEvent({
      type: "artifact.added",
      projectId: request.params.projectId,
      payload: { artifact, artifactKind: "link" },
    }, request.log)
  } catch (error) {
    sendError(reply, error)
  }
})

app.post("/api/projects/:projectId/artifacts/excalidraw", async (request, reply) => {
  try {
    const artifact = await addExcalidrawArtifact(request.params.projectId, request.body ?? {})
    reply.code(201).send(artifact)
    void emitAutomationEvent({
      type: "artifact.added",
      projectId: request.params.projectId,
      payload: { artifact, artifactKind: "excalidraw" },
    }, request.log)
  } catch (error) {
    sendError(reply, error)
  }
})

app.post("/api/projects/:projectId/artifacts/upload", async (request, reply) => {
  try {
    const file = await request.file()
    const artifact = await saveUpload(request.params.projectId, file, {
      author: file?.fields?.author?.value,
    })
    reply.code(201).send(artifact)
    void emitAutomationEvent({
      type: "artifact.added",
      projectId: request.params.projectId,
      payload: {
        artifact,
        artifactKind: path.extname(artifact.name).toLowerCase() === ".md" ? "markdown" : "file",
      },
    }, request.log)
  } catch (error) {
    sendError(reply, error)
  }
})

app.post("/api/projects/:projectId/tasks", async (request, reply) => {
  try {
    const task = await createTask(request.params.projectId, request.body ?? {})
    reply.code(201).send(task)
    void emitAutomationEvent({
      type: "task.added",
      projectId: request.params.projectId,
      payload: { task },
    }, request.log)
  } catch (error) {
    sendError(reply, error)
  }
})

app.patch("/api/projects/:projectId/tasks/readme", async (request, reply) => {
  try {
    reply.send(await updateTaskIndex(request.params.projectId, request.body ?? {}))
  } catch (error) {
    sendError(reply, error)
  }
})

app.patch("/api/projects/:projectId/artifacts/readme", async (request, reply) => {
  try {
    reply.send(await updateArtifactIndex(request.params.projectId, request.body ?? {}))
  } catch (error) {
    sendError(reply, error)
  }
})

app.patch("/api/projects/:projectId/tasks/content", async (request, reply) => {
  try {
    reply.send(
      await updateTask(
        request.params.projectId,
        String(request.query.path ?? ""),
        request.body ?? {}
      )
    )
  } catch (error) {
    sendError(reply, error)
  }
})

app.patch("/api/projects/:projectId/tasks/toggle", async (request, reply) => {
  try {
    reply.send(
      await toggleTask(
        request.params.projectId,
        String(request.query.path ?? ""),
        request.body?.done
      )
    )
  } catch (error) {
    sendError(reply, error)
  }
})

app.patch("/api/projects/:projectId/artifacts", async (request, reply) => {
  try {
    if (typeof request.body?.content === "string") {
      reply.send(
        await updateMarkdownArtifact(
          request.params.projectId,
          String(request.query.path ?? ""),
          request.body
        )
      )
      return
    }

    reply.code(400).send({ error: "Artifact filenames are stable" })
  } catch (error) {
    sendError(reply, error)
  }
})

app.patch("/api/projects/:projectId/artifacts/content", async (request, reply) => {
  try {
    reply.send(
      await updateMarkdownArtifact(
        request.params.projectId,
        String(request.query.path ?? ""),
        request.body ?? {}
      )
    )
  } catch (error) {
    sendError(reply, error)
  }
})

app.patch("/api/projects/:projectId/artifacts/excalidraw", async (request, reply) => {
  try {
    reply.send(
      await updateExcalidrawArtifact(
        request.params.projectId,
        String(request.query.path ?? ""),
        request.body ?? {}
      )
    )
  } catch (error) {
    sendError(reply, error)
  }
})

app.patch("/api/projects/:projectId/generated/content", async (request, reply) => {
  try {
    reply.send(
      await updateGeneratedMarkdown(
        request.params.projectId,
        String(request.query.path ?? ""),
        request.body ?? {}
      )
    )
  } catch (error) {
    sendError(reply, error)
  }
})

app.delete("/api/projects/:projectId/artifacts", async (request, reply) => {
  try {
    reply.send(await deleteArtifact(request.params.projectId, String(request.query.path ?? "")))
  } catch (error) {
    sendError(reply, error)
  }
})

app.delete("/api/projects/:projectId/tasks", async (request, reply) => {
  try {
    reply.send(await deleteTask(request.params.projectId, String(request.query.path ?? "")))
  } catch (error) {
    sendError(reply, error)
  }
})

app.get("/api/projects/:projectId/files/raw", async (request, reply) => {
  try {
    const relativePath = String(request.query.path ?? "")
    const file = await readProjectFile(request.params.projectId, relativePath)
    reply.type("text/plain; charset=utf-8").send(file.content)
  } catch (error) {
    sendError(reply, error)
  }
})

app.get("/api/docs/:docId/files/raw", async (request, reply) => {
  try {
    const relativePath = String(request.query.path ?? "")
    const file = await readDocFile(request.params.docId, relativePath)
    reply.type("text/plain; charset=utf-8").send(file.content)
  } catch (error) {
    sendError(reply, error)
  }
})

app.get("/api/projects/:projectId/files/download", async (request, reply) => {
  try {
    const relativePath = String(request.query.path ?? "")
    const stream = await createProjectFileStream(request.params.projectId, relativePath)
    return withDownloadSecurityHeaders(reply, relativePath, isSafeInlinePath(relativePath))
      .type(contentTypeForPath(relativePath))
      .send(stream)
  } catch (error) {
    sendError(reply, error)
  }
})

app.get("/api/docs/:docId/files/download", async (request, reply) => {
  try {
    const relativePath = String(request.query.path ?? "")
    const stream = await createDocFileStream(request.params.docId, relativePath)
    return withDownloadSecurityHeaders(reply, relativePath, isSafeInlinePath(relativePath))
      .type(contentTypeForPath(relativePath))
      .send(stream)
  } catch (error) {
    sendError(reply, error)
  }
})

app.register(fastifyStatic, {
  root: webDist,
  prefix: "/",
})

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith("/api/")) {
    reply.code(404).send({ error: "Not found" })
    return
  }

  reply.sendFile("index.html")
})

if (process.env.NODE_ENV !== "test") {
  await app.listen({ port, host })
}
