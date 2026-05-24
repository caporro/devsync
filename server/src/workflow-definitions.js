import fs from "node:fs/promises"
import path from "node:path"

import { dataDir, vaultDir } from "./storage.js"
import { hasFrontmatterKey, normalizeList, parseFrontmatter, readIfExists } from "./markdown-definitions.js"

const globalWorkflowsDir = path.join(vaultDir, "workflows")

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
  if (hasFrontmatterKey(data, key)) {
    return normalizeList(data[key])
  }

  if (hasFrontmatterKey(data, legacyKey)) {
    return normalizeList(data[legacyKey])
  }

  return fallback
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

async function loadWorkflowFile(filePath, source) {
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

async function discoverFromDir(workflowRoot, source) {
  let entries = []

  try {
    entries = await fs.readdir(workflowRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") {
      return []
    }

    throw error
  }

  const workflows = []
  const files = entries.filter(isMarkdownFile).sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of files) {
    const workflow = await loadWorkflowFile(path.join(workflowRoot, entry.name), source)

    if (workflow) {
      workflows.push(workflow)
    }
  }

  return workflows.sort((left, right) => left.title.localeCompare(right.title))
}

export async function listWorkflowDefinitions(options = {}) {
  const globalWorkflows = await discoverFromDir(globalWorkflowsDir, { type: "global" })

  if (!options.projectId) {
    return globalWorkflows
  }

  assertProjectId(options.projectId)
  const projectWorkflows = await discoverFromDir(
    path.join(dataDir, options.projectId, "workflows"),
    { type: "project", projectId: options.projectId }
  )

  return [...projectWorkflows, ...globalWorkflows]
}

export async function getWorkflowDefinition(workflowId, options = {}) {
  const workflows = await listWorkflowDefinitions(options)
  const requested = String(workflowId ?? "").trim()

  if (requested) {
    return workflows.find((workflow) => workflow.id === requested)
      ?? workflows.find((workflow) => workflow.key === requested)
      ?? null
  }

  return workflows[0] ?? null
}

export function formatWorkflowForApi(workflow) {
  return {
    id: workflow.id,
    key: workflow.key,
    title: workflow.title,
    description: workflow.description,
    model: workflow.model,
    tools: workflow.tools,
    trigger: workflow.trigger,
    cron: workflow.cron,
    events: workflow.events,
    eventFilter: workflow.eventFilter,
    read: workflow.read,
    write: workflow.write,
    source: workflow.source.type,
    projectId: workflow.source.projectId ?? null,
  }
}
