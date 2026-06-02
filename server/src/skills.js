import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { parseFrontmatter, readIfExists } from "./markdown-definitions.js"
import { vaultDir } from "./storage.js"

const SKILL_FILE = "SKILL.md"
const CONFIG_DIR = "config"
const SKILLS_CONFIG_FILE = "skills.json"

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const systemSkillsDir = path.resolve(process.env.DEVSYNC_SYSTEM_SKILLS_DIR ?? path.resolve(serverDir, "..", "skills"))
const vaultSkillsDir = path.join(vaultDir, "skills")
const skillsConfigPath = path.join(vaultDir, CONFIG_DIR, SKILLS_CONFIG_FILE)

function assertSkillName(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw Object.assign(new Error("Invalid skill name"), { statusCode: 400 })
  }
}

function normalizeDescription(data, body) {
  const description = String(data.description ?? "").trim()
  if (description) {
    return description.replace(/\r?\n/g, " ")
  }

  const firstLine = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  return firstLine?.replace(/^#+\s*/, "") ?? ""
}

function normalizeSkill(raw, filePath, source, dirName) {
  const { data, body } = parseFrontmatter(raw)
  const name = String(dirName).trim()
  assertSkillName(name)

  return {
    name,
    description: normalizeDescription(data, body),
    content: body,
    source,
    path: filePath,
  }
}

async function readSkillsConfig() {
  const raw = await readIfExists(skillsConfigPath)
  if (!raw) {
    return { disabledSystemSkills: [] }
  }

  const parsed = JSON.parse(raw)
  return {
    disabledSystemSkills: Array.isArray(parsed.disabledSystemSkills)
      ? parsed.disabledSystemSkills.map(String).map((name) => name.trim()).filter(Boolean)
      : [],
  }
}

async function discoverSkills(root, source, options = {}) {
  let entries = []

  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") {
      return []
    }
    throw error
  }

  const disabled = new Set(options.disabled ?? [])
  const skills = []

  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    if (disabled.has(entry.name)) {
      continue
    }

    assertSkillName(entry.name)
    const filePath = path.join(root, entry.name, SKILL_FILE)
    const raw = await readIfExists(filePath)

    if (!raw) {
      continue
    }

    const skill = normalizeSkill(raw, filePath, source, entry.name)
    if (!disabled.has(skill.name)) {
      skills.push(skill)
    }
  }

  return skills
}

export async function listSkills() {
  const config = await readSkillsConfig()
  const systemSkills = await discoverSkills(systemSkillsDir, "system", {
    disabled: config.disabledSystemSkills,
  })
  const vaultSkills = await discoverSkills(vaultSkillsDir, "vault")
  const byName = new Map()

  for (const skill of systemSkills) {
    byName.set(skill.name, skill)
  }

  for (const skill of vaultSkills) {
    byName.set(skill.name, skill)
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export async function getSkillCatalog() {
  return (await listSkills()).map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: skill.source,
  }))
}

export async function readSkill(name, options = {}) {
  const requested = String(name ?? "").trim()
  assertSkillName(requested)

  const allowed = options.allowedSkills
  if (Array.isArray(allowed) && !allowed.some((skill) => skill.name === requested)) {
    throw Object.assign(new Error(`Skill not available in this chat: ${requested}`), { statusCode: 404 })
  }

  const source = allowed?.find((skill) => skill.name === requested)?.source ?? null
  const candidates = source === "system"
    ? [path.join(systemSkillsDir, requested, SKILL_FILE)]
    : source === "vault"
      ? [path.join(vaultSkillsDir, requested, SKILL_FILE)]
      : [
          path.join(vaultSkillsDir, requested, SKILL_FILE),
          path.join(systemSkillsDir, requested, SKILL_FILE),
        ]

  for (const filePath of candidates) {
    const raw = await readIfExists(filePath)
    if (raw) {
      return normalizeSkill(raw, filePath, filePath.startsWith(vaultSkillsDir) ? "vault" : "system", requested)
    }
  }

  throw Object.assign(new Error(`Skill not found: ${requested}`), { statusCode: 404 })
}

export function formatSkillCatalogForPrompt(skills) {
  if (!skills?.length) {
    return ""
  }

  return [
    "<available_skills>",
    "Skills provide specialized capabilities and domain knowledge.",
    "When the user asks for a task, check whether any available skill matches.",
    "If a skill matches, this is a blocking requirement: call use_skill with the skill name before answering about the task, then follow the loaded skill instructions.",
    "Do not mention a skill unless you call use_skill.",
    "Do not call use_skill again if that skill was already loaded in this run.",
    "Slash commands like /project-status refer to skills. If the name matches an available skill, call use_skill.",
    "",
    "Available skills:",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description || "No description."}`),
    "</available_skills>",
  ].join("\n")
}
