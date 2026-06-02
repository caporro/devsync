import "./env.js"
import fs from "node:fs/promises"
import path from "node:path"
import { appendSystemLogEvent, listSystemLogEvents } from "./system-log.js"

const dataRootDir = path.resolve(process.env.DEVSYNC_DATA_ROOT ?? path.join(process.cwd(), "data"))
const vaultName = String(process.env.DEVSYNC_VAULT_NAME ?? "devsync-vault").trim() || "devsync-vault"
const usersDir = path.join(dataRootDir, "users")
const mentionPattern = /@\[([^\]\n]+)\]\(devsync:user:([^) \t\r\n]+)\)/g

function cleanUserId(value) {
  const raw = String(value ?? "").trim().toLowerCase()
  return raw || "team"
}

function decodeMentionUserId(value) {
  try {
    return cleanUserId(decodeURIComponent(String(value ?? "")))
  } catch {
    return cleanUserId(value)
  }
}

function decodeMentionLabel(value) {
  return String(value ?? "").replace(/\\([\\[\]])/g, "$1").trim()
}

function safeUserDirName(userId) {
  const safe = cleanUserId(userId)
    .replace(/[^a-z0-9._@-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140)

  return safe && safe !== "." && safe !== ".." ? safe : "team"
}

function inboxStatePath(userId) {
  return path.join(usersDir, safeUserDirName(userId), "inbox-state.json")
}

function targetTypeFromPath(target) {
  const value = String(target ?? "")
  if (value.startsWith("resources/") || value.startsWith("artifacts/")) return "resource"
  if (value.startsWith("work/") || value.startsWith("generated/")) return "work"
  if (value.startsWith("tasks/")) return "task"
  if (value.startsWith("logs/")) return "activity"
  return "file"
}

function mentionContent(markdown, mention) {
  const text = String(markdown ?? "").replace(/\r\n?/g, "\n")
  const index = Number(mention.index ?? -1)
  const start = index >= 0 ? text.lastIndexOf("\n", index) + 1 : 0
  const nextLine = index >= 0 ? text.indexOf("\n", index) : -1
  const end = nextLine === -1 ? text.length : nextLine

  return text
    .slice(start, end)
    .replace(/@\[([^\]\n]+)\]\(devsync:user:[^) \t\r\n]+\)/g, (_match, label) => `@${decodeMentionLabel(label)}`)
    .replace(/!?\[([^\]\n]*)\]\([^)\n]+\)/g, "$1")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
}

export function userInboxId(user) {
  return cleanUserId(user?.email ?? user?.username ?? user?.name ?? "team")
}

export function extractUserMentions(markdown) {
  const mentions = []
  const text = String(markdown ?? "")
  let match

  while ((match = mentionPattern.exec(text))) {
    const userId = decodeMentionUserId(match[2])
    if (!userId) continue

    mentions.push({
      index: match.index,
      label: decodeMentionLabel(match[1]) || userId,
      raw: match[0],
      userId,
    })
  }

  mentionPattern.lastIndex = 0
  return mentions
}

export function addedUserMentions(before, after) {
  const beforeCounts = new Map()

  for (const mention of extractUserMentions(before)) {
    beforeCounts.set(mention.userId, (beforeCounts.get(mention.userId) ?? 0) + 1)
  }

  return extractUserMentions(after).filter((mention) => {
    const remaining = beforeCounts.get(mention.userId) ?? 0
    if (remaining > 0) {
      beforeCounts.set(mention.userId, remaining - 1)
      return false
    }

    return true
  })
}

export async function appendMentionEvents({
  actor,
  after,
  before = "",
  projectId,
  source = "storage",
  target,
  targetType,
} = {}) {
  const added = addedUserMentions(before, after)
  const events = []

  for (const mention of added) {
    events.push(
      await appendSystemLogEvent({
        action: "mention.created",
        source,
        actor,
        projectId,
        target,
        summary: `Mentioned ${mention.label}`,
        metadata: {
          label: mention.label,
          content: mentionContent(after, mention),
          mention: mention.raw,
          targetType: targetType ?? targetTypeFromPath(target),
          userId: mention.userId,
          vault: vaultName,
        },
      })
    )
  }

  return events
}

export async function readInboxState(userId) {
  try {
    return JSON.parse(await fs.readFile(inboxStatePath(userId), "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") {
      return { lastReadAt: null }
    }

    throw error
  }
}

export async function markInboxRead(user, input = {}) {
  const userId = userInboxId(user)
  const requested = Date.parse(String(input.lastReadAt ?? ""))
  const lastReadAt = Number.isFinite(requested)
    ? new Date(requested).toISOString()
    : new Date().toISOString()
  const target = inboxStatePath(userId)
  const state = { lastReadAt }

  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  return state
}

export async function listMentionInbox(user, options = {}) {
  const userId = userInboxId(user)
  const limit = Math.max(1, Math.min(Number(options.limit ?? 200) || 200, 1000))
  const [state, systemLog] = await Promise.all([
    readInboxState(userId),
    listSystemLogEvents({
      unbounded: true,
      action: "mention.created",
      metadata: { userId },
    }),
  ])
  const lastReadAt = state.lastReadAt ?? null
  const items = systemLog.items
    .filter((event) => !event.metadata?.vault || event.metadata.vault === vaultName)
    .slice(0, limit)
    .map((event) => ({
      id: event.id,
      actor: event.actor,
      createdAt: event.createdAt,
      label: String(event.metadata?.label ?? userId),
      content: typeof event.metadata?.content === "string" ? event.metadata.content : null,
      projectId: event.projectId,
      summary: event.summary,
      target: event.target,
      targetType: String(event.metadata?.targetType ?? targetTypeFromPath(event.target)),
      unread: !lastReadAt || event.createdAt > lastReadAt,
      userId,
    }))

  return {
    items,
    lastReadAt,
    unreadCount: systemLog.items.filter((event) => (
      (!event.metadata?.vault || event.metadata.vault === vaultName) &&
      (!lastReadAt || event.createdAt > lastReadAt)
    )).length,
    userId,
  }
}
