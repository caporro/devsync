import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"

import { appendSystemLogEvent } from "./system-log.js"
import { dataRootDir, vaultName } from "./storage.js"

const USER_KEY_LENGTH = 12
const runtimeChatsDir = path.join(dataRootDir, "runtime", vaultName, "chats")

function nowIso() {
  return new Date().toISOString()
}

function assertThreadId(threadId) {
  if (!/^[a-f0-9-]{36}$/i.test(threadId)) {
    throw Object.assign(new Error("Invalid thread id"), { statusCode: 400 })
  }
}

function assertUserKey(userKey) {
  if (!/^[a-f0-9]{12}$/i.test(userKey)) {
    throw Object.assign(new Error("Invalid user key"), { statusCode: 400 })
  }
}

function assertAttachmentId(attachmentId) {
  if (!/^[a-f0-9-]{36}$/i.test(attachmentId)) {
    throw Object.assign(new Error("Invalid attachment id"), { statusCode: 400 })
  }
}

function assertRunId(runId) {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) {
    throw Object.assign(new Error("Invalid run id"), { statusCode: 400 })
  }
}

export function hashThreadUserKey(value) {
  return createHash("sha256")
    .update(String(value).trim().toLowerCase())
    .digest("hex")
    .slice(0, USER_KEY_LENGTH)
}

function activeThreadPath(threadId, userKey) {
  assertThreadId(threadId)
  assertUserKey(userKey)

  return path.join(runtimeChatsDir, userKey, `${threadId}.json`)
}

function threadAttachmentDir(threadId, userKey) {
  assertThreadId(threadId)
  assertUserKey(userKey)

  return path.join(runtimeChatsDir, userKey, threadId, "attachments")
}

function cleanFileName(input) {
  return path
    .basename(String(input || "file"))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140) || "file"
}

async function uniquePath(dir, wantedName) {
  const parsed = path.parse(cleanFileName(wantedName))
  let candidate = `${parsed.name}${parsed.ext}`
  let index = 1

  while (true) {
    const target = path.join(dir, candidate)
    try {
      await fs.access(target)
      candidate = `${parsed.name}${index}${parsed.ext}`
      index += 1
    } catch {
      return target
    }
  }
}

function serializeThread(thread) {
  return `${JSON.stringify(thread, null, 2)}\n`
}

async function ensureChatsDir() {
  await fs.mkdir(runtimeChatsDir, { recursive: true })
}

async function ensureUserChatsDir(userKey) {
  assertUserKey(userKey)
  await ensureChatsDir()
  await fs.mkdir(path.join(runtimeChatsDir, userKey), { recursive: true })
}

async function readThreadFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"))
}

async function readActiveThreadFile(threadId, userKey) {
  return readThreadFile(activeThreadPath(threadId, userKey))
}

function publicThread(thread) {
  return {
    id: thread.id,
    title: thread.title,
    agentId: thread.agentId ?? "assistant",
    projectId: thread.projectId ?? null,
    skills: thread.skills ?? [],
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  }
}

function publicAttachment(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    path: attachment.path,
    mimeType: attachment.mimeType,
    size: attachment.size,
    createdAt: attachment.createdAt,
  }
}

function publicMessage(message) {
  return {
    ...message,
    attachments: (message.attachments ?? []).map(publicAttachment),
  }
}

function latestRunEvent(run, eventName) {
  return [...(run.events ?? [])].reverse().find((event) => event.event === eventName) ?? null
}

function reconcileThreadRuns(thread) {
  let changed = false

  const runs = (thread.runs ?? []).map((run) => {
    if (run.status !== "running") {
      return run
    }

    const terminalEvent = [...(run.events ?? [])]
      .reverse()
      .find((event) => event.event === "run_completed" || event.event === "error")
    const messageEvent = latestRunEvent(run, "message")
    const assistantMessage = [...(thread.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant" && message.runId === run.id)

    if (!terminalEvent && !messageEvent && !assistantMessage) {
      return run
    }

    changed = true
    const status = terminalEvent?.event === "error" ? "error" : "completed"
    const timestamp =
      terminalEvent?.createdAt ??
      messageEvent?.createdAt ??
      assistantMessage?.createdAt ??
      run.updatedAt ??
      nowIso()

    return {
      ...run,
      status,
      updatedAt: timestamp,
      completedAt: status === "completed" ? timestamp : run.completedAt ?? timestamp,
    }
  })

  return {
    changed,
    thread: changed ? { ...thread, runs } : thread,
  }
}

function publicRun(run) {
  return {
    id: run.id,
    status: run.status,
    userMessageId: run.userMessageId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt ?? null,
    events: run.events ?? [],
    streamUrl: run.status === "running" ? `/api/agent-runs/${run.id}/stream` : null,
  }
}

export async function listAgentThreads(options = {}) {
  assertUserKey(options.userKey ?? "")
  await ensureUserChatsDir(options.userKey)
  const expectedProjectId = options.projectId ?? null
  const directory = path.join(runtimeChatsDir, options.userKey)
  let entries = []
  const threads = []

  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") {
      return []
    }

    throw error
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue
    }

    try {
      const thread = await readThreadFile(path.join(directory, entry.name))

      if ((thread.projectId ?? null) === expectedProjectId) {
        threads.push(publicThread(thread))
      }
    } catch {
      continue
    }
  }

  return threads.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export async function createAgentThread(input, options = {}) {
  const userKey = options.userKey
  await ensureUserChatsDir(userKey)
  const timestamp = nowIso()
  const thread = {
    id: randomUUID(),
    title: input.title ?? null,
    agentId: input.agentId ?? "assistant",
    projectId: input.projectId ?? null,
    skills: input.skills ?? [],
    userKey,
    userEmail: options.userEmail ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    attachments: [],
    runs: [],
    messages: [],
  }

  await writeThread(thread.id, thread, userKey)
  await appendSystemLogEvent({
    action: "chat_thread.created",
    source: "agent-store",
    actor: options.userEmail ?? userKey,
    projectId: thread.projectId,
    target: `${userKey}/${thread.id}.json`,
    summary: `Created chat thread ${thread.title ?? thread.id}`,
  })
  return publicThread(thread)
}

export async function getAgentThread(threadId, userKey) {
  const current = await readActiveThreadFile(threadId, userKey)
  const { changed, thread } = reconcileThreadRuns(current)

  if (changed) {
    await writeThread(thread.id, thread, userKey)
  }

  return {
    thread: publicThread(thread),
    attachments: (thread.attachments ?? []).map(publicAttachment),
    runs: (thread.runs ?? []).map(publicRun),
    messages: (thread.messages ?? []).map(publicMessage),
  }
}

export async function deleteAgentThread(threadId, userKey) {
  let deleted = false

  try {
    await fs.unlink(activeThreadPath(threadId, userKey))
    deleted = true
  } catch (error) {
    if (error.code !== "ENOENT" && error.statusCode !== 404) {
      throw error
    }
  }

  if (!deleted) {
    return false
  }

  await appendSystemLogEvent({
    action: "chat_thread.deleted",
    source: "agent-store",
    actor: userKey,
    target: `${userKey}/${threadId}.json`,
    summary: `Deleted chat thread ${threadId}`,
  })
  return true
}

async function writeThread(threadId, thread, userKey) {
  await ensureUserChatsDir(userKey)
  await fs.writeFile(activeThreadPath(threadId, userKey), serializeThread(thread), "utf8")
}

export async function appendAgentMessage(threadId, input, userKey) {
  const thread = await readActiveThreadFile(threadId, userKey)
  const timestamp = nowIso()
  const attachmentsById = new Map((thread.attachments ?? []).map((attachment) => [attachment.id, attachment]))
  const attachments = (input.attachmentIds ?? []).map((attachmentId) => {
    const attachment = attachmentsById.get(attachmentId)
    if (!attachment) {
      throw Object.assign(new Error("Attachment not found"), { statusCode: 404 })
    }
    return attachment
  })
  const message = {
    id: randomUUID(),
    role: input.role,
    content: input.content,
    runId: input.runId ?? null,
    attachments: attachments.map(publicAttachment),
    createdAt: timestamp,
  }

  if (input.threadTitle && !thread.title) {
    thread.title = input.threadTitle
  }

  thread.messages = [...(thread.messages ?? []), message]
  thread.updatedAt = timestamp
  await writeThread(thread.id, thread, userKey)
  await appendSystemLogEvent({
    action: "chat_message.appended",
    source: "agent-store",
    actor: userKey,
    projectId: thread.projectId,
    target: `${userKey}/${thread.id}.json`,
    summary: `Appended ${message.role} message`,
    metadata: { role: message.role, runId: message.runId },
  })

  return message
}

export async function saveAgentThreadAttachment(threadId, filePart, userKey) {
  const thread = await readActiveThreadFile(threadId, userKey)

  if (!filePart?.filename) {
    throw Object.assign(new Error("File is required"), { statusCode: 400 })
  }

  const timestamp = nowIso()
  const dir = threadAttachmentDir(threadId, userKey)
  await fs.mkdir(dir, { recursive: true })
  const target = await uniquePath(dir, filePart.filename)
  await pipeline(filePart.file, createWriteStream(target))
  const stat = await fs.stat(target)

  const attachment = {
    id: randomUUID(),
    name: path.basename(target),
    path: path.relative(dataRootDir, target).split(path.sep).join("/"),
    mimeType: String(filePart.mimetype ?? "application/octet-stream"),
    size: stat.size,
    createdAt: timestamp,
  }

  thread.attachments = [...(thread.attachments ?? []), attachment]
  thread.updatedAt = timestamp
  await writeThread(thread.id, thread, userKey)
  await appendSystemLogEvent({
    action: "chat_attachment.uploaded",
    source: "agent-store",
    actor: userKey,
    projectId: thread.projectId,
    target: `${userKey}/${thread.id}/${attachment.name}`,
    summary: `Uploaded chat attachment ${attachment.name}`,
    metadata: { attachmentId: attachment.id, mimeType: attachment.mimeType, size: attachment.size },
  })

  return publicAttachment(attachment)
}

export async function readAgentThreadAttachment(threadId, attachmentId, userKey) {
  const thread = await readActiveThreadFile(threadId, userKey)
  assertAttachmentId(attachmentId)
  const attachment = (thread.attachments ?? []).find((item) => item.id === attachmentId)

  if (!attachment) {
    throw Object.assign(new Error("Attachment not found"), { statusCode: 404 })
  }

  const fullPath = path.resolve(dataRootDir, attachment.path)
  const relative = path.relative(dataRootDir, fullPath)

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Invalid attachment path"), { statusCode: 400 })
  }

  return {
    ...publicAttachment(attachment),
    fullPath,
    stream: createReadStream(fullPath),
    buffer: () => fs.readFile(fullPath),
  }
}

export async function createAgentRun(threadId, input, userKey) {
  const thread = await readActiveThreadFile(threadId, userKey)
  const timestamp = nowIso()
  const run = {
    id: input.id,
    status: "running",
    userMessageId: input.userMessageId,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    events: [],
  }

  assertRunId(run.id)
  thread.runs = [...(thread.runs ?? []), run]
  thread.updatedAt = timestamp
  await writeThread(thread.id, thread, userKey)

  return publicRun(run)
}

export async function appendAgentRunEventToThread(threadId, runId, event, data, userKey) {
  const thread = await readActiveThreadFile(threadId, userKey)
  const timestamp = nowIso()
  let didUpdate = false

  thread.runs = (thread.runs ?? []).map((run) => {
    if (run.id !== runId) {
      return run
    }

    didUpdate = true
    const status = event === "run_completed" ? "completed" : event === "error" ? "error" : run.status
    return {
      ...run,
      status,
      updatedAt: timestamp,
      completedAt: status === "running" ? run.completedAt ?? null : timestamp,
      events: [...(run.events ?? []), { event, data, createdAt: timestamp }],
    }
  })

  if (!didUpdate) {
    throw Object.assign(new Error("Run not found"), { statusCode: 404 })
  }

  thread.updatedAt = timestamp
  await writeThread(thread.id, thread, userKey)
}
