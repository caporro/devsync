import fs from "node:fs/promises"
import path from "node:path"

import { dataDir, vaultDir } from "./storage.js"
import { hasFrontmatterKey, normalizeList, parseFrontmatter, readIfExists } from "./markdown-definitions.js"
import { appendSystemLogEvent } from "./system-log.js"

const ASSISTANT_FILE = "assistant.md"
const ROLES_DIR = "roles"
const LEGACY_VAULT_SYSTEM_FILE = "system.md"
const LEGACY_PROJECT_CONTEXT_FILE = "agents.md"
const LEGACY_AGENTS_DIR = "agents"

export const ASSISTANT_ID = "assistant"

export const BASE_ASSISTANT_PROMPT = [
  "You are the main Devsync Assistant.",
  "Devsync is filesystem-first project memory for team documentation, artifacts and activity logs.",
  "There is only one Assistant. Roles are temporary prompt specializations, not separate agents.",
  "Keep answers practical, concise and grounded in the available project files.",
  "Do not modify files unless the user clearly asks for that action.",
].join("\n")

function assertProjectId(projectId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    throw Object.assign(new Error("Invalid project id"), { statusCode: 400 })
  }
}

function assertRoleSlug(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw Object.assign(new Error("Invalid role slug"), { statusCode: 400 })
  }
}

function slugify(input) {
  const slug = String(input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return slug || "role"
}

function projectRoot(projectId) {
  assertProjectId(projectId)
  return path.join(dataDir, projectId)
}

function scopeRoot(scope, projectId) {
  if (scope === "vault") {
    return vaultDir
  }

  if (scope === "project") {
    if (!projectId) {
      throw Object.assign(new Error("Project id is required"), { statusCode: 400 })
    }
    return projectRoot(projectId)
  }

  throw Object.assign(new Error("Invalid role scope"), { statusCode: 400 })
}

function rolePath(scope, slug, projectId) {
  assertRoleSlug(slug)
  return path.join(scopeRoot(scope, projectId), ROLES_DIR, `${slug}.md`)
}

function humanizeSlug(slug) {
  return String(slug)
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function compactFrontmatterString(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim()
}

function serializeRole(input) {
  const name = compactFrontmatterString(input.name)
  const description = compactFrontmatterString(input.description)
  const content = String(input.content ?? "").trim()

  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    content,
    "",
  ].join("\n")
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

function normalizeAssistantAccess(data, key, legacyKey) {
  if (hasFrontmatterKey(data, key)) {
    return normalizeList(data[key])
  }

  if (hasFrontmatterKey(data, legacyKey)) {
    return normalizeList(data[legacyKey])
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
    tools: ["filesystem"],
    read: ["**/*"],
    write: ["plan/**", "artifacts/**", "generated/**"],
  }
}

function normalizeRole(raw, filePath, scope, projectId, overridesVault = false) {
  const { data, body } = parseFrontmatter(raw)
  const slug = path.basename(filePath, ".md")

  return {
    slug,
    name: String(data.name ?? humanizeSlug(slug)).trim(),
    description: String(data.description ?? "").trim(),
    content: body,
    scope,
    projectId: scope === "project" ? projectId : null,
    overridesVault,
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

async function discoverRoles(scope, projectId = null) {
  const rolesRoot = path.join(scopeRoot(scope, projectId), ROLES_DIR)
  let entries = []

  try {
    entries = await fs.readdir(rolesRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") {
      return []
    }
    throw error
  }

  const roles = []
  const files = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".md")
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of files) {
    const filePath = path.join(rolesRoot, entry.name)
    roles.push(normalizeRole(await fs.readFile(filePath, "utf8"), filePath, scope, projectId))
  }

  return roles.sort((left, right) => left.name.localeCompare(right.name))
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

export async function listAssistantRoles(options = {}) {
  const projectId = options.projectId ?? null
  if (projectId) {
    assertProjectId(projectId)
  }

  const vaultRoles = await discoverRoles("vault")

  if (!projectId) {
    return vaultRoles
  }

  const projectRoles = await discoverRoles("project", projectId)
  const projectSlugs = new Set(projectRoles.map((role) => role.slug))
  const vaultSlugs = new Set(vaultRoles.map((role) => role.slug))

  return [
    ...vaultRoles.filter((role) => !projectSlugs.has(role.slug)),
    ...projectRoles.map((role) => ({
      ...role,
      overridesVault: vaultSlugs.has(role.slug),
    })),
  ]
}

export async function readAssistantRole(scope, slug, projectId = null) {
  const filePath = rolePath(scope, slug, projectId)
  const raw = await readIfExists(filePath)

  if (!raw) {
    return null
  }

  const overridesVault = scope === "project"
    ? Boolean(await readIfExists(rolePath("vault", slug)))
    : false

  return normalizeRole(raw, filePath, scope, projectId, overridesVault)
}

export async function createAssistantRole(input) {
  const scope = input.scope
  const projectId = input.projectId ?? null
  const slug = slugify(input.slug ?? input.name)
  const filePath = rolePath(scope, slug, projectId)

  try {
    await fs.access(filePath)
    throw Object.assign(new Error("Role already exists"), { statusCode: 409 })
  } catch (error) {
    if (error.statusCode === 409) {
      throw error
    }
    if (error.code !== "ENOENT") {
      throw error
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(
    filePath,
    serializeRole({
      name: input.name ?? humanizeSlug(slug),
      description: input.description ?? "",
      content: input.content ?? "",
    }),
    "utf8"
  )
  await appendSystemLogEvent({
    action: "assistant_role.created",
    source: "assistant-config",
    actor: input.author ?? input.creator ?? "team",
    projectId,
    target: `${scope}/roles/${slug}.md`,
    summary: `Created assistant role ${slug}`,
  })

  return readAssistantRole(scope, slug, projectId)
}

export async function updateAssistantRole(scope, slug, input) {
  const projectId = input.projectId ?? null
  const current = await readAssistantRole(scope, slug, projectId)

  if (!current) {
    return null
  }

  await fs.writeFile(
    rolePath(scope, slug, projectId),
    serializeRole({
      name: input.name === undefined ? current.name : input.name,
      description: input.description === undefined ? current.description : input.description,
      content: input.content === undefined ? current.content : input.content,
    }),
    "utf8"
  )
  await appendSystemLogEvent({
    action: "assistant_role.updated",
    source: "assistant-config",
    actor: input.author ?? input.editor ?? "team",
    projectId,
    target: `${scope}/roles/${slug}.md`,
    summary: `Updated assistant role ${slug}`,
  })

  return readAssistantRole(scope, slug, projectId)
}

export async function deleteAssistantRole(scope, slug, projectId = null) {
  try {
    await fs.unlink(rolePath(scope, slug, projectId))
    await appendSystemLogEvent({
      action: "assistant_role.deleted",
      source: "assistant-config",
      actor: "team",
      projectId,
      target: `${scope}/roles/${slug}.md`,
      summary: `Deleted assistant role ${slug}`,
    })
    return true
  } catch (error) {
    if (error.code === "ENOENT") {
      return false
    }
    throw error
  }
}

export async function resolveAssistantRole(slug, options = {}) {
  const requested = String(slug ?? "").trim()

  if (!requested) {
    return null
  }

  assertRoleSlug(requested)

  if (options.projectId) {
    const projectRole = await readAssistantRole("project", requested, options.projectId)
    if (projectRole) {
      return projectRole
    }
  }

  return readAssistantRole("vault", requested)
}

export async function loadAssistantInstructionContext(projectId, selectedRole = null) {
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

  if (selectedRole) {
    const role = await resolveAssistantRole(selectedRole, { projectId })

    if (!role) {
      throw Object.assign(new Error(`Unknown role: ${selectedRole}`), { statusCode: 400 })
    }

    parts.push(tagPrompt("selected_role", role.content))
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

export function formatRoleForApi(role) {
  return {
    slug: role.slug,
    name: role.name,
    description: role.description,
    content: role.content,
    scope: role.scope,
    projectId: role.projectId ?? null,
    overridesVault: Boolean(role.overridesVault),
  }
}
