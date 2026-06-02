import { randomUUID } from "node:crypto"
import path from "node:path"

import { z } from "zod"

import {
  createAssistantRole,
  deleteAssistantRole,
  formatAssistantForApi,
  formatRoleForApi,
  getAssistantConfig,
  listAssistantRoles,
  readAssistantRole,
  updateAssistantRole,
} from "./assistant-config.js"
import {
  formatAutomationForApi,
  getAutomationDefinition,
  listAutomationDefinitions,
} from "./automation-definitions.js"
import { runAutomation } from "./automation-runtime.js"
import {
  appendAgentMessage,
  appendAgentRunEventToThread,
  createAgentRun,
  createAgentThread,
  deleteAgentThread,
  getAgentThread,
  listAgentThreads,
  hashThreadUserKey,
  readAgentThreadAttachment,
  saveAgentThreadAttachment,
} from "./agent-store.js"
import {
  appendAgentRunEvent,
  createAgentRunStream,
  subscribeToAgentRunStream,
} from "./agent-run-streams.js"
import { runAgent } from "./agent-runtime.js"
import { readProjectFileBuffer } from "./storage.js"

const CreateThreadBody = z.object({
  title: z.string().trim().min(1).nullable().optional(),
  agentId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).nullable().optional(),
})

const CreateMessageBody = z.object({
  content: z.string().trim().min(1),
  attachmentIds: z.array(z.string().trim().min(1)).optional(),
  selectedRole: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1).nullable().optional(),
})

const RoleScope = z.enum(["vault", "project"])

const SaveRoleBody = z.object({
  scope: RoleScope,
  projectId: z.string().trim().min(1).nullable().optional(),
  slug: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  content: z.string().optional(),
})

const UpdateRoleBody = z.object({
  projectId: z.string().trim().min(1).nullable().optional(),
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  content: z.string().optional(),
})

const RunAutomationBody = z.object({
  projectId: z.string().trim().min(1),
  input: z.string().trim().optional(),
})

const DEFAULT_THREAD_USER = "team"
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpg", ".jpeg", ".png", ".webp"])

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const types = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  }

  return types[ext] ?? "application/octet-stream"
}

function threadUserFromRequest(request, auth) {
  const user = auth.currentUser(request) ?? { email: DEFAULT_THREAD_USER, username: DEFAULT_THREAD_USER }
  const userEmail = String(user.email ?? user.username ?? DEFAULT_THREAD_USER).trim().toLowerCase()
  const resolvedEmail = userEmail.length > 0 ? userEmail : DEFAULT_THREAD_USER

  return {
    email: resolvedEmail,
    key: hashThreadUserKey(resolvedEmail),
  }
}

function serializeSse(reply, event, data) {
  reply.raw.write(`event: ${event}\n`)
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
}

function markdownProjectFilePath(url) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/api\/)/i.test(url)) {
    return null
  }

  let normalized = String(url).split(/[?#]/, 1)[0].replace(/\\/g, "/")

  try {
    normalized = decodeURIComponent(normalized)
  } catch {
    // Keep original URL if it is not URI encoded.
  }

  normalized = normalized
    .replace(/^\/+/, "")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^(?:\.\.\/)+/, "")

  if (normalized.startsWith("artifacts/")) return `resources/${normalized.slice("artifacts/".length)}`
  if (normalized.startsWith("generated/")) return `work/${normalized.slice("generated/".length)}`

  return /^(?:resources|work|tasks)\//.test(normalized) ? normalized : null
}

function markdownLinkUrl(value) {
  const url = String(value).trim().split(/\s+/, 1)[0] ?? ""
  return url.replace(/^<(.+)>$/, "$1")
}

function extractProjectLinks(markdown) {
  const links = []
  const pattern = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g
  let match

  while ((match = pattern.exec(markdown))) {
    const filePath = markdownProjectFilePath(markdownLinkUrl(match[1]))
    if (filePath) {
      links.push(filePath)
    }
  }

  return [...new Set(links)]
}

function isImagePath(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function dataUrl(mimeType, buffer) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`
}

async function imagePartFromAttachment(threadId, attachment, threadUser) {
  if (!isImagePath(attachment.name)) {
    return null
  }

  const file = await readAgentThreadAttachment(threadId, attachment.id, threadUser.key)
  const safeMimeType = contentTypeForPath(file.path)
  return {
    type: "image_url",
    image_url: { url: dataUrl(safeMimeType, await file.buffer()) },
  }
}

async function imagePartFromProjectFile(projectId, filePath) {
  if (!projectId || !isImagePath(filePath)) {
    return null
  }

  const file = await readProjectFileBuffer(projectId, filePath)
  return {
    type: "image_url",
    image_url: { url: dataUrl(contentTypeForPath(file.path), file.buffer) },
  }
}

async function buildRuntimeMessages({ history, threadId, threadUser, emit }) {
  const runtimeMessages = []

  for (const message of history.messages) {
    if (message.role !== "user") {
      runtimeMessages.push({ role: message.role, content: message.content })
      continue
    }

    const content = [{ type: "text", text: message.content }]
    const imageNames = []

    for (const attachment of message.attachments ?? []) {
      const part = await imagePartFromAttachment(threadId, attachment, threadUser)
      if (part) {
        content.push(part)
        imageNames.push(attachment.name)
      }
    }

    for (const filePath of extractProjectLinks(message.content)) {
      const part = await imagePartFromProjectFile(history.thread.projectId, filePath)
      if (part) {
        content.push(part)
        imageNames.push(filePath)
      }
    }

    if (imageNames.length > 0) {
      emit?.("context", {
        kind: "images",
        items: imageNames,
        summary: `Sent ${imageNames.length} image${imageNames.length === 1 ? "" : "s"} to the model`,
      })
    }

    runtimeMessages.push({
      role: message.role,
      content: content.length === 1 ? message.content : content,
    })
  }

  return runtimeMessages
}

async function executeThreadRun({ threadId, runId, requestLog, threadUser }) {
  let persistQueue = Promise.resolve()

  const emit = (event, data) => {
    appendAgentRunEvent(runId, event, data)
    if (event === "token") {
      return
    }

    persistQueue = persistQueue.then(() =>
      appendAgentRunEventToThread(threadId, runId, event, data, threadUser.key)
    ).catch((error) => {
      requestLog?.error({ error: error?.message ?? error, runId, threadId }, "failed to persist assistant run event")
    })
  }

  try {
    const history = await getAgentThread(threadId, threadUser.key)
    const agent = await getAssistantConfig(history.thread.projectId)
    const lastUserMessage = [...history.messages].reverse().find((message) => message.role === "user")
    const selectedRole = lastUserMessage?.selectedRole ?? null
    const runtimeMessages = await buildRuntimeMessages({ history, threadId, threadUser, emit })
    await persistQueue

    const result = await runAgent({
      agent,
      projectId: history.thread.projectId,
      messages: runtimeMessages,
      selectedRole,
      eventSink: emit,
      log: requestLog,
    })
    await persistQueue

    const assistantMessage = await appendAgentMessage(threadId, {
      role: "assistant",
      content: result.answer,
      runId,
    }, threadUser.key)

    emit("message", assistantMessage)
    emit("run_completed", {
      id: runId,
      status: "completed",
      model: agent.model,
    })
    await persistQueue
  } catch (error) {
    await persistQueue
    const message = error instanceof Error ? error.message : "Assistant run failed"
    requestLog?.error({ error: message, runId, threadId }, "assistant run failed")
    emit("error", { message })
    await persistQueue
  }
}

export async function registerAgentRoutes(app, auth) {
  app.get("/api/assistant", async (request) => {
    const projectId = request.query?.projectId ? String(request.query.projectId) : null
    return formatAssistantForApi(await getAssistantConfig(projectId))
  })

  app.get("/api/assistant/roles", async (request) => {
    const projectId = request.query?.projectId ? String(request.query.projectId) : null
    const roles = await listAssistantRoles({ projectId })

    return {
      items: roles.map(formatRoleForApi),
    }
  })

  app.get("/api/assistant/roles/:scope/:slug", async (request, reply) => {
    const scope = RoleScope.safeParse(request.params.scope)
    if (!scope.success) {
      reply.code(400).send({ error: "Invalid role scope" })
      return
    }

    const projectId = request.query?.projectId ? String(request.query.projectId) : null
    const role = await readAssistantRole(scope.data, request.params.slug, projectId)

    if (!role) {
      reply.code(404).send({ error: "Role not found" })
      return
    }

    return formatRoleForApi(role)
  })

  app.post("/api/assistant/roles", async (request, reply) => {
    const parsed = SaveRoleBody.safeParse(request.body ?? {})

    if (!parsed.success) {
      reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() })
      return
    }

    if (!parsed.data.name && !parsed.data.slug) {
      reply.code(400).send({ error: "Role name or slug is required" })
      return
    }

    const role = await createAssistantRole(parsed.data)
    reply.code(201).send(formatRoleForApi(role))
  })

  app.put("/api/assistant/roles/:scope/:slug", async (request, reply) => {
    const scope = RoleScope.safeParse(request.params.scope)
    if (!scope.success) {
      reply.code(400).send({ error: "Invalid role scope" })
      return
    }

    const parsed = UpdateRoleBody.safeParse(request.body ?? {})

    if (!parsed.success) {
      reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() })
      return
    }

    const role = await updateAssistantRole(scope.data, request.params.slug, parsed.data)

    if (!role) {
      reply.code(404).send({ error: "Role not found" })
      return
    }

    return formatRoleForApi(role)
  })

  app.delete("/api/assistant/roles/:scope/:slug", async (request, reply) => {
    const scope = RoleScope.safeParse(request.params.scope)
    if (!scope.success) {
      reply.code(400).send({ error: "Invalid role scope" })
      return
    }

    const projectId = request.query?.projectId ? String(request.query.projectId) : null
    const deleted = await deleteAssistantRole(scope.data, request.params.slug, projectId)

    if (!deleted) {
      reply.code(404).send({ error: "Role not found" })
      return
    }

    reply.code(204).send()
  })

  app.get("/api/agents", async (request) => {
    const projectId = request.query?.projectId ? String(request.query.projectId) : null
    const assistant = await getAssistantConfig(projectId)

    return {
      deprecated: true,
      items: [{
        ...formatAssistantForApi(assistant),
        scope: "both",
        source: projectId ? "project" : "global",
      }],
    }
  })

  app.get("/api/automations", async (request) => {
    const projectId = request.query?.projectId ? String(request.query.projectId) : null
    const automations = await listAutomationDefinitions({ projectId })

    return {
      items: automations.map(formatAutomationForApi),
    }
  })

  app.post("/api/automations/:automationId/runs", async (request, reply) => {
    const parsed = RunAutomationBody.safeParse(request.body ?? {})

    if (!parsed.success) {
      reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() })
      return
    }

    const automation = await getAutomationDefinition(request.params.automationId, {
      projectId: parsed.data.projectId,
    })

    if (!automation) {
      reply.code(404).send({ error: "Automation not found" })
      return
    }

    reply.code(201).send({
      automation: formatAutomationForApi(automation),
      result: await runAutomation({
        automation,
        projectId: parsed.data.projectId,
        input: parsed.data.input ?? "",
        log: request.log,
      }),
    })
  })

  app.get("/api/agent-threads", async (request) => {
    const threadUser = threadUserFromRequest(request, auth)
    const projectId = request.query?.projectId ? String(request.query.projectId) : null

    return {
      items: await listAgentThreads({ projectId, userKey: threadUser.key }),
    }
  })

  app.post("/api/agent-threads", async (request, reply) => {
    const threadUser = threadUserFromRequest(request, auth)
    const parsed = CreateThreadBody.safeParse(request.body ?? {})

    if (!parsed.success) {
      reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() })
      return
    }

    const projectId = parsed.data.projectId ?? null
    const assistant = await getAssistantConfig(projectId)

    reply.code(201).send(await createAgentThread({
      title: parsed.data.title ?? null,
      agentId: assistant.id,
      projectId,
    }, {
      userKey: threadUser.key,
      userEmail: threadUser.email,
    }))
  })

  app.get("/api/agent-threads/:threadId", async (request, reply) => {
    const threadUser = threadUserFromRequest(request, auth)
    try {
      reply.send(await getAgentThread(request.params.threadId, threadUser.key))
    } catch (error) {
      if (error.code === "ENOENT" || error.statusCode === 404) {
        reply.code(404).send({ error: "Thread not found" })
        return
      }
      throw error
    }
  })

  app.post("/api/agent-threads/:threadId/attachments", async (request, reply) => {
    const threadUser = threadUserFromRequest(request, auth)
    const file = await request.file()
    const attachment = await saveAgentThreadAttachment(request.params.threadId, file, threadUser.key)

    reply.code(201).send(attachment)
  })

  app.get("/api/agent-threads/:threadId/attachments/:attachmentId", async (request, reply) => {
    const threadUser = threadUserFromRequest(request, auth)
    const attachment = await readAgentThreadAttachment(
      request.params.threadId,
      request.params.attachmentId,
      threadUser.key
    )
    const safeMimeType = contentTypeForPath(attachment.name)
    const fileName = attachment.name.replace(/[\r\n"\\]/g, "").trim() || "file"

    reply.header("Content-Type", safeMimeType)
    reply.header("Content-Length", String(attachment.size))
    reply.header("Content-Disposition", `${isImagePath(attachment.name) ? "inline" : "attachment"}; filename="${fileName}"`)
    reply.header("X-Content-Type-Options", "nosniff")
    reply.header("X-Frame-Options", "DENY")
    reply.header("Cross-Origin-Resource-Policy", "same-origin")
    reply.header("Referrer-Policy", "no-referrer")
    return reply.send(attachment.stream)
  })

  app.delete("/api/agent-threads/:threadId", async (request, reply) => {
    const threadUser = threadUserFromRequest(request, auth)
    const deleted = await deleteAgentThread(request.params.threadId, threadUser.key)

    if (!deleted) {
      reply.code(404).send({ error: "Thread not found" })
      return
    }

    reply.code(204).send()
  })

  app.post("/api/agent-threads/:threadId/messages", async (request, reply) => {
    const parsed = CreateMessageBody.safeParse(request.body ?? {})

    if (!parsed.success) {
      reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() })
      return
    }

    const threadUser = threadUserFromRequest(request, auth)
    const runId = randomUUID()
    const userMessage = await appendAgentMessage(request.params.threadId, {
      role: "user",
      content: parsed.data.content,
      attachmentIds: parsed.data.attachmentIds ?? [],
      selectedRole: parsed.data.selectedRole ?? null,
      threadTitle: parsed.data.title ?? null,
      runId,
    }, threadUser.key)

    createAgentRunStream(runId)
    await createAgentRun(request.params.threadId, {
      id: runId,
      userMessageId: userMessage.id,
    }, threadUser.key)

    const runStarted = {
      runId,
      threadId: request.params.threadId,
      userMessageId: userMessage.id,
    }
    appendAgentRunEvent(runId, "run_started", runStarted)
    await appendAgentRunEventToThread(request.params.threadId, runId, "run_started", runStarted, threadUser.key)

    void executeThreadRun({
      threadId: request.params.threadId,
      runId,
      requestLog: request.log,
      threadUser,
    })

    reply.code(202).send({
      run: {
        id: runId,
        status: "running",
      },
      userMessage,
      streamUrl: `/api/agent-runs/${runId}/stream`,
    })
  })

  app.get("/api/agent-runs/:runId/stream", async (request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.flushHeaders()

    let closed = false
    const subscription = subscribeToAgentRunStream(request.params.runId, (event) => {
      if (closed) {
        return
      }

      serializeSse(reply, event.event, event.data)
      if (event.event === "run_completed" || event.event === "error") {
        closed = true
        reply.raw.end()
      }
    })

    if (!subscription) {
      reply.raw.end()
      return reply
    }

    request.raw.on("close", () => {
      if (closed) {
        return
      }
      closed = true
      subscription.unsubscribe()
    })

    if (subscription.terminal && !closed) {
      closed = true
      reply.raw.end()
    }

    return reply
  })
}
