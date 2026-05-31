import "./env.js"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

const dataRootDir = path.resolve(process.env.DEVSYNC_DATA_ROOT ?? path.join(process.cwd(), "data"))
const systemLogDir = path.join(dataRootDir, "system")
const systemLogFile = path.join(systemLogDir, "events.ndjson")

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
  const limit = Math.max(1, Math.min(Number(options.limit ?? 200) || 200, 1000))

  try {
    const raw = await fs.readFile(systemLogFile, "utf8")
    const events = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)

    return {
      path: path.relative(dataRootDir, systemLogFile).split(path.sep).join("/"),
      items: events.slice(-limit).reverse(),
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
