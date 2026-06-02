import fs from "node:fs/promises"
import path from "node:path"

import { dataDir, vaultDir } from "./storage.js"
import { hasFrontmatterKey, normalizeList, parseFrontmatter, readIfExists } from "./markdown-definitions.js"

const globalAutomationsDir = path.join(vaultDir, "automations")

function assertProjectId(projectId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    throw Object.assign(new Error("Invalid project id"), { statusCode: 400 })
  }
}

function isMarkdownFile(entry) {
  return entry.isFile() && path.extname(entry.name).toLowerCase() === ".md"
}

function normalizeTools(data) {
  return hasFrontmatterKey(data, "tools") ? normalizeList(data.tools) : ["filesystem"]
}

function normalizeAccess(data, key, legacyKey, fallback) {
  const normalizeProjectAccessPaths = (items) => items.map((item) => {
    const value = String(item)
    if (value === "artifacts" || value.startsWith("artifacts/")) return `resources${value.slice("artifacts".length)}`
    if (value === "generated" || value.startsWith("generated/")) return `work${value.slice("generated".length)}`
    return value
  })

  if (hasFrontmatterKey(data, key)) {
    return normalizeProjectAccessPaths(normalizeList(data[key]))
  }

  if (hasFrontmatterKey(data, legacyKey)) {
    return normalizeProjectAccessPaths(normalizeList(data[legacyKey]))
  }

  return normalizeProjectAccessPaths(fallback)
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

async function loadAutomationFile(filePath, source) {
  const raw = await readIfExists(filePath)

  if (!raw) {
    return null
  }

  const { data, body } = parseFrontmatter(raw)
  const key = String(data.key ?? data.id ?? path.basename(filePath, ".md")).trim()
  const id = source.type === "project" ? `project:${source.projectId}:${key}` : `global:${key}`
  const model = (data.model_env ? process.env[String(data.model_env)] : undefined)
    ?? data.model
    ?? process.env.DEVSYNC_AGENT_MODEL
    ?? data.model_default
    ?? "openai:gpt-4.1-mini"

  return {
    id,
    key,
    title: String(data.title ?? data.name ?? key).trim(),
    description: String(data.description ?? "").trim(),
    model: String(model).trim(),
    tools: normalizeTools(data),
    trigger: String(data.trigger ?? "manual").trim() || "manual",
    cron: String(data.cron ?? "").trim(),
    events: normalizeList(data.events),
    eventFilter: normalizeObject(data.eventFilter),
    read: normalizeAccess(data, "read", "reads", ["**/*"]),
    write: normalizeAccess(data, "write", "writes", []),
    source: {
      ...source,
      path: filePath,
    },
    prompt: body,
  }
}

async function discoverFromDir(automationRoot, source) {
  let entries = []

  try {
    entries = await fs.readdir(automationRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") {
      return []
    }

    throw error
  }

  const automations = []
  const files = entries.filter(isMarkdownFile).sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of files) {
    const automation = await loadAutomationFile(path.join(automationRoot, entry.name), source)

    if (automation) {
      automations.push(automation)
    }
  }

  return automations.sort((left, right) => left.title.localeCompare(right.title))
}

export async function listAutomationDefinitions(options = {}) {
  const globalAutomations = await discoverFromDir(globalAutomationsDir, { type: "global" })

  if (!options.projectId) {
    return globalAutomations
  }

  assertProjectId(options.projectId)
  const projectAutomations = await discoverFromDir(
    path.join(dataDir, options.projectId, "automations"),
    { type: "project", projectId: options.projectId }
  )

  return [...projectAutomations, ...globalAutomations]
}

export async function getAutomationDefinition(automationId, options = {}) {
  const automations = await listAutomationDefinitions(options)
  const requested = String(automationId ?? "").trim()

  if (requested) {
    return automations.find((automation) => automation.id === requested)
      ?? automations.find((automation) => automation.key === requested)
      ?? null
  }

  return automations[0] ?? null
}

export function formatAutomationForApi(automation) {
  return {
    id: automation.id,
    key: automation.key,
    title: automation.title,
    description: automation.description,
    model: automation.model,
    tools: automation.tools,
    trigger: automation.trigger,
    cron: automation.cron,
    events: automation.events,
    eventFilter: automation.eventFilter,
    read: automation.read,
    write: automation.write,
    source: automation.source.type,
    projectId: automation.source.projectId ?? null,
  }
}
