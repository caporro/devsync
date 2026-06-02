import fs from "node:fs/promises"
import path from "node:path"

import { dataDir, vaultDir } from "./storage.js"
import { hasFrontmatterKey, normalizeList, parseFrontmatter, readIfExists } from "./markdown-definitions.js"

const ASSISTANT_FILE = "assistant.md"
const LEGACY_VAULT_SYSTEM_FILE = "system.md"
const LEGACY_PROJECT_CONTEXT_FILE = "agents.md"
const LEGACY_AGENTS_DIR = "agents"

export const ASSISTANT_ID = "assistant"

export const BASE_ASSISTANT_PROMPT = [
  "You are Devsync Assistant, an interactive operational assistant running inside a Devsync installation for a team.",
  "Use the available tools to help the team manage context, resources, tasks, activity logs, produced work, and automations.",
  "Devsync is filesystem-first: data must stay readable, inspectable, and versionable in the vault.",
  "The mounted filesystem root is your working area. Treat all paths as relative to it unless the system explicitly says otherwise.",
  "Do not read, write, infer access to, or mention data outside the mounted root unless a tool explicitly exposes it and the user clearly asks for it.",
  "",
  "Working area structure:",
  "- project.json: metadata only.",
  "- README.md: main notes and stable context.",
  "- assistant.md: Assistant instructions for this working area.",
  "- resources/: source material, uploads, links, notes, images, PDFs, and raw inputs.",
  "- logs/activity/: append-only activity timeline for users, Assistant, automations, and system-originated updates.",
  "- tasks/: operational tasks, follow-ups, decisions to complete, and task index.",
  "- work/: outputs produced or refined by users, Assistant, or automations.",
  "- automations/: automation definitions for this working area.",
  "",
  "Use each folder according to its purpose:",
  "- Put raw or source material in resources/.",
  "- Put generated or refined deliverables in work/.",
  "- Put operational next steps in tasks/.",
  "- Append short readable updates to logs/activity/ when an activity log tool or workflow is available.",
  "- If an activity entry would be long, save it as Markdown in resources/ or work/ and keep only a short linked entry in the log.",
  "",
  "Operating rules:",
  "- Prefer the simplest solution that works.",
  "- Read relevant files before changing them.",
  "- Use available Devsync tools instead of inventing actions.",
  "- Never write outside the allowed working area.",
  "- Never delete or overwrite data without explicit confirmation.",
  "- Preserve filesystem-readable data: Markdown for narrative content, small JSON for metadata.",
  "- Keep outputs concise, practical, and action-oriented.",
  "- If the user asks for a concrete change, do it end-to-end unless blocked.",
  "- Ask only one focused question when no safe default exists.",
  "- Do not claim an action succeeded unless the tool result confirms it.",
  "",
  "Skills are reusable task instructions loaded with tools, not separate agents.",
].join("\n")

function assertProjectId(projectId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    throw Object.assign(new Error("Invalid project id"), { statusCode: 400 })
  }
}

function projectRoot(projectId) {
  assertProjectId(projectId)
  return path.join(dataDir, projectId)
}

function uniqueList(...groups) {
  const seen = new Set()
  const values = []

  for (const group of groups) {
    for (const item of group ?? []) {
      const value = String(item ?? "").trim()

      if (!value || seen.has(value)) {
        continue
      }

      seen.add(value)
      values.push(value)
    }
  }

  return values
}

function normalizeAssistantTools(data) {
  return hasFrontmatterKey(data, "tools") ? normalizeList(data.tools) : []
}

function normalizeProjectAccessPaths(items) {
  return items.map((item) => {
    const value = String(item)
    if (value === "artifacts" || value.startsWith("artifacts/")) return `resources${value.slice("artifacts".length)}`
    if (value === "generated" || value.startsWith("generated/")) return `work${value.slice("generated".length)}`
    return value
  })
}

function normalizeAssistantAccess(data, key, legacyKey) {
  if (hasFrontmatterKey(data, key)) {
    return normalizeProjectAccessPaths(normalizeList(data[key]))
  }

  if (hasFrontmatterKey(data, legacyKey)) {
    return normalizeProjectAccessPaths(normalizeList(data[legacyKey]))
  }

  return null
}

function resolveAssistantModel(data, fallback) {
  return String(
    (data.model_env ? process.env[String(data.model_env)] : undefined)
      ?? data.model
      ?? data.model_default
      ?? fallback
  ).trim()
}

function normalizeAssistantConfig() {
  const model = process.env.DEVSYNC_ASSISTANT_MODEL
    ?? process.env.DEVSYNC_AGENT_MODEL
    ?? "openai:gpt-4.1-mini"

  return {
    id: ASSISTANT_ID,
    key: ASSISTANT_ID,
    title: "Assistant",
    description: "Main Devsync chat assistant.",
    model: String(model).trim(),
    tools: ["filesystem", "use_skill"],
    read: ["**/*"],
    write: ["tasks/**", "resources/**", "work/**", "automations/**"],
  }
}

function normalizeAssistantDefinition(raw, filePath, source, fallbackModel) {
  const { data, body } = parseFrontmatter(raw)

  return {
    title: String(data.title ?? data.name ?? "").trim(),
    description: String(data.description ?? "").trim(),
    model: resolveAssistantModel(data, fallbackModel),
    tools: normalizeAssistantTools(data),
    read: normalizeAssistantAccess(data, "read", "reads"),
    write: normalizeAssistantAccess(data, "write", "writes"),
    prompt: body,
    source: {
      ...source,
      path: filePath,
    },
  }
}

async function readAssistantDefinitionFile(filePath, source, fallbackModel) {
  const raw = await readIfExists(filePath)

  if (!raw) {
    return null
  }

  return normalizeAssistantDefinition(raw, filePath, source, fallbackModel)
}

function tagPrompt(label, content) {
  return content ? `<${label}>\n${content.trim()}\n</${label}>` : null
}

async function readFirstLegacyAgentDefinition(root, source, fallbackModel) {
  const legacyRoot = path.join(root, LEGACY_AGENTS_DIR)
  let entries = []

  try {
    entries = await fs.readdir(legacyRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") {
      return null
    }
    throw error
  }

  const files = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".md")
    .sort((left, right) => left.name.localeCompare(right.name))

  if (files[0]) {
    return readAssistantDefinitionFile(
      path.join(legacyRoot, files[0].name),
      { ...source, legacy: true, kind: "legacy-agent-file" },
      fallbackModel
    )
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))

  if (dirs[0]) {
    return readAssistantDefinitionFile(
      path.join(legacyRoot, dirs[0].name, "AGENT.md"),
      { ...source, legacy: true, kind: "legacy-agent-dir" },
      fallbackModel
    )
  }

  return null
}

async function readVaultAssistantDefinition(fallbackModel) {
  return await readAssistantDefinitionFile(
    path.join(vaultDir, ASSISTANT_FILE),
    { scope: "vault", legacy: false, kind: "assistant" },
    fallbackModel
  )
    ?? await readAssistantDefinitionFile(
      path.join(vaultDir, LEGACY_VAULT_SYSTEM_FILE),
      { scope: "vault", legacy: true, kind: "legacy-system" },
      fallbackModel
    )
    ?? await readFirstLegacyAgentDefinition(vaultDir, { scope: "vault" }, fallbackModel)
}

async function readProjectAssistantDefinition(projectId, fallbackModel) {
  if (!projectId) {
    return null
  }

  const root = projectRoot(projectId)
  return await readAssistantDefinitionFile(
    path.join(root, ASSISTANT_FILE),
    { scope: "project", projectId, legacy: false, kind: "assistant" },
    fallbackModel
  )
    ?? await readAssistantDefinitionFile(
      path.join(root, LEGACY_PROJECT_CONTEXT_FILE),
      { scope: "project", projectId, legacy: true, kind: "legacy-agents-md" },
      fallbackModel
    )
    ?? await readFirstLegacyAgentDefinition(root, { scope: "project", projectId }, fallbackModel)
}

export function assistantScopeRoot(projectId) {
  if (!projectId) {
    return vaultDir
  }

  return projectRoot(projectId)
}

export async function getAssistantConfig(projectId = null) {
  if (projectId) {
    assertProjectId(projectId)
  }

  const base = normalizeAssistantConfig()
  const vaultAssistant = await readVaultAssistantDefinition(base.model)
  const projectAssistant = await readProjectAssistantDefinition(projectId, vaultAssistant?.model ?? base.model)
  const assistantChain = [vaultAssistant, projectAssistant].filter(Boolean)
  const declaredRead = assistantChain.filter((assistant) => assistant.read !== null)
  const declaredWrite = assistantChain.filter((assistant) => assistant.write !== null)

  return {
    ...base,
    title: projectAssistant?.title || vaultAssistant?.title || base.title,
    description: projectAssistant?.description || vaultAssistant?.description || base.description,
    model: projectAssistant?.model || vaultAssistant?.model || base.model,
    tools: uniqueList(base.tools, ...assistantChain.map((assistant) => assistant.tools)),
    read: declaredRead.length
      ? uniqueList(...declaredRead.map((assistant) => assistant.read))
      : base.read,
    write: declaredWrite.length
      ? uniqueList(...declaredWrite.map((assistant) => assistant.write))
      : base.write,
    projectId: projectId ?? null,
    overrides: {
      vault: Boolean(vaultAssistant),
      project: Boolean(projectAssistant),
    },
    sources: {
      vault: vaultAssistant?.source ?? null,
      project: projectAssistant?.source ?? null,
    },
  }
}

export async function loadAssistantInstructionContext(projectId) {
  const parts = []
  const base = normalizeAssistantConfig()
  const vaultAssistant = await readVaultAssistantDefinition(base.model)
  const projectAssistant = await readProjectAssistantDefinition(projectId, vaultAssistant?.model ?? base.model)
  const vaultPrompt = tagPrompt("vault_assistant", vaultAssistant?.prompt)
  const projectPrompt = tagPrompt("project_assistant", projectAssistant?.prompt)

  if (vaultPrompt) {
    parts.push(vaultPrompt)
  }

  if (projectPrompt) {
    parts.push(projectPrompt)
  }

  return parts.join("\n\n")
}

export function formatAssistantForApi(assistant) {
  return {
    id: assistant.id,
    key: assistant.key,
    title: assistant.title,
    description: assistant.description,
    model: assistant.model,
    tools: assistant.tools,
    read: assistant.read,
    write: assistant.write,
    projectId: assistant.projectId ?? null,
    overrides: assistant.overrides,
    sources: assistant.sources,
  }
}
