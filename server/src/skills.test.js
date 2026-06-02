import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-skills-"))
const vaultName = "skills-vault"
const systemSkillsDir = path.join(tempRoot, "system-skills")

process.env.NODE_ENV = "test"
process.env.DEVSYNC_DATA_ROOT = tempRoot
process.env.DEVSYNC_VAULT_NAME = vaultName
process.env.DEVSYNC_SYSTEM_SKILLS_DIR = systemSkillsDir

const vaultDir = path.join(tempRoot, vaultName)

await fs.mkdir(path.join(systemSkillsDir, "project-status"), { recursive: true })
await fs.writeFile(
  path.join(systemSkillsDir, "project-status", "SKILL.md"),
  [
    "---",
    "name: project-status",
    "description: System status skill",
    "---",
    "System instructions.",
    "",
  ].join("\n"),
  "utf8"
)
await fs.mkdir(path.join(systemSkillsDir, "extract-tasks"), { recursive: true })
await fs.writeFile(
  path.join(systemSkillsDir, "extract-tasks", "SKILL.md"),
  [
    "---",
    "name: extract-tasks",
    "description: Extract tasks",
    "---",
    "Task instructions.",
    "",
  ].join("\n"),
  "utf8"
)
await fs.mkdir(path.join(vaultDir, "config"), { recursive: true })
await fs.writeFile(
  path.join(vaultDir, "config", "skills.json"),
  `${JSON.stringify({ disabledSystemSkills: ["extract-tasks"] }, null, 2)}\n`,
  "utf8"
)
await fs.mkdir(path.join(vaultDir, "skills", "project-status"), { recursive: true })
await fs.writeFile(
  path.join(vaultDir, "skills", "project-status", "SKILL.md"),
  [
    "---",
    "name: project-status",
    "description: Vault status skill",
    "---",
    "Vault instructions.",
    "",
  ].join("\n"),
  "utf8"
)

const { getSkillCatalog, readSkill } = await import("./skills.js")

after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true })
})

test("vault skills override system skills and config disables system skills", async () => {
  const catalog = await getSkillCatalog()

  assert.deepEqual(catalog, [{
    name: "project-status",
    description: "Vault status skill",
    source: "vault",
  }])
})

test("readSkill only allows skills from the chat catalog", async () => {
  const catalog = await getSkillCatalog()
  const skill = await readSkill("project-status", { allowedSkills: catalog })

  assert.equal(skill.source, "vault")
  assert.equal(skill.content, "Vault instructions.")

  await assert.rejects(
    () => readSkill("extract-tasks", { allowedSkills: catalog }),
    /Skill not available/
  )
})
