import "./env.js"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

const dataRootDir = path.resolve(process.env.DEVSYNC_DATA_ROOT ?? path.join(process.cwd(), "data"))
const systemLogDir = path.join(dataRootDir, "system")
const systemLogFile = path.join(systemLogDir, "events.ndjson")
const DEFAULT_SYSTEM_LOG_LIMIT = 200
const MAX_SYSTEM_LOG_LIMIT = 1000

function nowIso() {
  return new Date().toISOString()
}

function compact(value) {
  return String(value ?? "").trim() || null
}

function cleanEvent(input = {}) {
  return {
    id: randomUUID(),
    createdAt: nowIso(),
    action: compact(input.action) ?? "write",
    source: compact(input.source) ?? "server",
    actor: compact(input.actor),
    projectId: compact(input.projectId),
    target: compact(input.target),
    summary: compact(input.summary),
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : undefined,
  }
}

export async function appendSystemLogEvent(input = {}) {
  const event = cleanEvent(input)
  await fs.mkdir(systemLogDir, { recursive: true })
  await fs.appendFile(systemLogFile, `${JSON.stringify(event)}\n`, "utf8")
  return event
}

export async function listSystemLogEvents(options = {}) {
  const limit = Math.max(
    1,
    Math.min(Number(options.limit ?? DEFAULT_SYSTEM_LOG_LIMIT) || DEFAULT_SYSTEM_LOG_LIMIT, MAX_SYSTEM_LOG_LIMIT)
  )
  const unbounded = options.unbounded === true
  const actionFilter = typeof options.action === "string" ? options.action.trim() : ""
  const metadataFilter = options.metadata && typeof options.metadata === "object" && !Array.isArray(options.metadata)
    ? options.metadata
    : null

  const isMetadataMatch = (metadata = {}) => {
    if (!metadataFilter) {
      return true
    }

    for (const [key, rawExpected] of Object.entries(metadataFilter)) {
      if (rawExpected == null) continue
      const expected = String(rawExpected).trim()
      if (!expected) continue

      if (metadata == null || String(metadata[key] ?? "") !== expected) {
        return false
      }
    }

    return true
  }

  const matchesAction = (event) => (
    !actionFilter || String(event.action ?? "") === actionFilter
  )

  try {
    const raw = await fs.readFile(systemLogFile, "utf8")
    const events = []

    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      let event = null

      try {
        event = JSON.parse(line)
      } catch {
        // ignore malformed line
      }

      if (
        event &&
        matchesAction(event) &&
        isMetadataMatch(event.metadata)
      ) {
        events.push(event)
      }
    }

    const baseIndex = unbounded ? 0 : Math.max(0, events.length - limit)

    return {
      path: path.relative(dataRootDir, systemLogFile).split(path.sep).join("/"),
      items: events.slice(baseIndex).reverse(),
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        path: path.relative(dataRootDir, systemLogFile).split(path.sep).join("/"),
        items: [],
      }
    }

    throw error
  }
}
