import "./env.js"
import { createReadStream, createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { appendMentionEvents } from "./mentions.js"
import { appendSystemLogEvent } from "./system-log.js"

const PROJECT_FILE = "project.json"
const PLANNING_FILE = "vault-plan.json"
const LEGACY_GANTT_FILE = "gantt.json"
const PROJECT_DIRS = ["artifacts", "logs", "generated", "plan", "roles", "automations"]
const LEGACY_ACTIVITY_LOG_FILE = "activity.md"
const ACTIVITY_LOG_DIR = "activity"
const ARTIFACTS_README_FILE = "readme.md"
const PLAN_README_FILE = "README.md"
const LEGACY_PLAN_README_FILE = "readme.md"
const EXCALIDRAW_EXTENSION = ".excalidraw"
const ACTIVITY_INLINE_MAX_CHARS = Number(process.env.DEVSYNC_ACTIVITY_INLINE_MAX_CHARS ?? 800)
const ACTIVITY_LOG_ENTRIES_PER_FILE = Number(process.env.DEVSYNC_ACTIVITY_LOG_ENTRIES_PER_FILE ?? 50)
const DEFAULT_ACTIVITY_LOG_FILES = Number(process.env.DEVSYNC_ACTIVITY_LOG_FILES ?? 2)

function resolveVaultName() {
  const name = String(process.env.DEVSYNC_VAULT_NAME ?? "devsync-vault").trim()

  if (!name || name === "." || name === ".." || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Invalid DEVSYNC_VAULT_NAME")
  }

  return name
}

const legacyDataDir = process.env.DEVSYNC_DATA_DIR

export const vaultName = resolveVaultName()
export const dataRootDir = path.resolve(process.env.DEVSYNC_DATA_ROOT ?? path.join(process.cwd(), "data"))
export const vaultDir = path.resolve(legacyDataDir ? path.dirname(legacyDataDir) : path.join(dataRootDir, vaultName))
export const dataDir = path.resolve(legacyDataDir ?? path.join(vaultDir, "projects"))
export const docsDir = path.join(vaultDir, "docs")
const planningPath = path.join(vaultDir, PLANNING_FILE)
const legacyGanttPath = path.join(vaultDir, LEGACY_GANTT_FILE)

function nowIso() {
  return new Date().toISOString()
}

function dateStamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-")
}

export function slugify(input) {
  const slug = String(input)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return slug || `project-${Date.now()}`
}

function humanizeProjectId(projectId) {
  return String(projectId).replace(/[-_]+/g, " ").trim() || projectId
}

function assertProjectId(projectId) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(projectId)) {
    throw Object.assign(new Error("Invalid project id"), { statusCode: 400 })
  }
}

function assertDocId(docId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(docId)) {
    throw Object.assign(new Error("Invalid docs folder id"), { statusCode: 400 })
  }
}

function projectPath(projectId) {
  assertProjectId(projectId)
  return path.join(dataDir, projectId)
}

function docPath(docId) {
  assertDocId(docId)
  return path.join(docsDir, docId)
}

function metadataPath(projectId) {
  return path.join(projectPath(projectId), PROJECT_FILE)
}

function legacyActivityLogPath(projectId) {
  return path.join(projectPath(projectId), "logs", LEGACY_ACTIVITY_LOG_FILE)
}

function activityLogDirPath(projectId) {
  return path.join(projectPath(projectId), "logs", ACTIVITY_LOG_DIR)
}

function activitySegmentPath(projectId, fileName) {
  return path.join(activityLogDirPath(projectId), fileName)
}

function artifactIndexPath(projectId) {
  return path.join(projectPath(projectId), "artifacts", ARTIFACTS_README_FILE)
}

function planIndexPath(projectId) {
  return path.join(projectPath(projectId), "plan", PLAN_README_FILE)
}

function legacyPlanDirPath(projectId) {
  return path.join(projectPath(projectId), "tasks")
}

function isArtifactIndexName(fileName) {
  return String(fileName).toLowerCase() === ARTIFACTS_README_FILE
}

function isPlanIndexName(fileName) {
  return String(fileName).toLowerCase() === PLAN_README_FILE.toLowerCase()
}

function isArtifactIndexPath(relativePath) {
  return String(relativePath).split(path.sep).join("/").toLowerCase() === `artifacts/${ARTIFACTS_README_FILE}`
}

function isPlanIndexPath(relativePath) {
  return String(relativePath).split(path.sep).join("/").toLowerCase() === `plan/${PLAN_README_FILE.toLowerCase()}`
}

function isMarkdownName(fileName) {
  return path.extname(String(fileName)).toLowerCase() === ".md"
}

function isExcalidrawName(fileName) {
  return path.extname(String(fileName)).toLowerCase() === EXCALIDRAW_EXTENSION
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function normalizeList(value) {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean)
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
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

async function ensureProjectDirs(projectId) {
  const root = projectPath(projectId)
  await ensureSafeDir(root)
  await Promise.all(PROJECT_DIRS.map((dir) => ensureSafeDir(path.join(root, dir))))
}

function storagePathError(message = "Invalid file path") {
  return Object.assign(new Error(message), { statusCode: 400 })
}

function pathInside(root, target) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function assertRealPathInside(root, target, message = "Invalid file path") {
  const realRoot = await fs.realpath(root)
  let realTarget

  try {
    realTarget = await fs.realpath(target)
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }

    realTarget = await fs.realpath(path.dirname(target))
  }

  if (!pathInside(realRoot, realTarget)) {
    throw storagePathError(message)
  }
}

async function ensureSafeDir(target) {
  try {
    const stat = await fs.lstat(target)

    if (stat.isSymbolicLink()) {
      throw storagePathError()
    }

    if (!stat.isDirectory()) {
      throw Object.assign(new Error("Not a directory"), { statusCode: 400 })
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }

  await fs.mkdir(target, { recursive: true })
  await assertRealPathInside(vaultDir, target)
}

async function assertSafeExistingFile(root, target, message = "Invalid file path") {
  await assertRealPathInside(root, target, message)
  const stat = await fs.lstat(target)

  if (stat.isSymbolicLink()) {
    throw storagePathError(message)
  }

  if (!stat.isFile()) {
    throw Object.assign(new Error("Not a file"), { statusCode: 400 })
  }

  return stat
}

async function assertSafeWritableFile(root, target, message = "Invalid file path") {
  await assertRealPathInside(root, path.dirname(target), message)

  try {
    const stat = await fs.lstat(target)

    if (stat.isSymbolicLink()) {
      throw storagePathError(message)
    }

    if (!stat.isFile()) {
      throw Object.assign(new Error("Not a file"), { statusCode: 400 })
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }
}

async function safeReadTextFile(target) {
  await assertSafeExistingFile(vaultDir, target)
  return fs.readFile(target, "utf8")
}

async function safeReadBuffer(target) {
  await assertSafeExistingFile(vaultDir, target)
  return fs.readFile(target)
}

async function safeWriteTextFile(target, content) {
  await assertSafeWritableFile(vaultDir, target)
  await fs.writeFile(target, content, "utf8")
}

async function safeAppendTextFile(target, content) {
  await assertSafeWritableFile(vaultDir, target)
  await fs.appendFile(target, content, "utf8")
}

async function safeUnlinkFile(target) {
  await assertSafeExistingFile(vaultDir, target)
  await fs.unlink(target)
}

async function safeReadStream(target) {
  await assertSafeExistingFile(vaultDir, target)
  return createReadStream(target)
}

async function safeUploadStream(target, input) {
  await assertSafeWritableFile(vaultDir, target)
  await pipeline(input, createWriteStream(target, { flags: "wx" }))
}

async function readJson(filePath) {
  const raw = await safeReadTextFile(filePath)
  return JSON.parse(raw)
}

function normalizeGanttDate(value) {
  if (!value) {
    return ""
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }

  const raw = String(value).trim()
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  if (match) {
    return match[1]
  }

  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : ""
}

function normalizeGanttTask(input) {
  const task = { ...(input ?? {}) }
  const id = task.id === undefined || task.id === null || String(task.id).trim() === ""
    ? `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : task.id
  const duration = Number(task.duration)
  const progress = Number(task.progress)

  task.id = typeof id === "number" ? id : String(id)
  task.text = String(task.text ?? task.title ?? "Untitled").trim() || "Untitled"
  task.status = String(task.status ?? "").trim()
  task.external_id = String(task.external_id ?? "").trim()
  task.link = String(task.link ?? "").trim()
  if (task.start) task.start = normalizeGanttDate(task.start)
  if (task.end) task.end = normalizeGanttDate(task.end)
  if (Number.isFinite(duration) && duration >= 0) task.duration = duration
  if (Number.isFinite(progress)) task.progress = Math.max(0, Math.min(100, progress))
  if (task.parent !== undefined && task.parent !== null && String(task.parent).trim() !== "") {
    task.parent = typeof task.parent === "number" ? task.parent : String(task.parent)
  } else {
    delete task.parent
  }

  return task
}

function normalizeGanttLink(input) {
  const link = { ...(input ?? {}) }

  if (link.source === undefined || link.target === undefined) {
    return null
  }

  const type = ["s2s", "s2e", "e2s", "e2e"].includes(link.type) ? link.type : "e2s"
  return {
    ...link,
    id: link.id === undefined || link.id === null || String(link.id).trim() === ""
      ? `${link.source}-${link.target}-${type}`
      : link.id,
    source: typeof link.source === "number" ? link.source : String(link.source),
    target: typeof link.target === "number" ? link.target : String(link.target),
    type,
  }
}

function normalizeGanttData(input = {}) {
  return {
    tasks: Array.isArray(input.tasks) ? input.tasks.map(normalizeGanttTask) : [],
    links: Array.isArray(input.links) ? input.links.map(normalizeGanttLink).filter(Boolean) : [],
    updatedAt: String(input.updatedAt ?? "").trim(),
  }
}

function persistedProjectMetadata(metadata) {
  const rest = { ...metadata }
  delete rest.id
  delete rest[["ji", "ra"].join("")]
  return rest
}

async function writeProjectMetadata(projectId, metadata) {
  await safeWriteTextFile(metadataPath(projectId), `${JSON.stringify(persistedProjectMetadata(metadata), null, 2)}\n`)
}

async function inferProjectMetadata(projectId) {
  const stat = await fs.stat(projectPath(projectId))
  const createdAt = stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : stat.mtime.toISOString()

  return {
    owner: "",
    status: "active",
    tags: [],
    createdAt,
    updatedAt: stat.mtime.toISOString(),
  }
}

async function touchProject(projectId) {
  const metadata = await getProjectMetadata(projectId)
  metadata.updatedAt = nowIso()
  await writeProjectMetadata(projectId, metadata)
  return metadata
}

async function uniquePath(dir, wantedName) {
  const parsed = path.parse(cleanFileName(wantedName))
  let candidate = `${parsed.name}${parsed.ext}`
  let index = 1

  while (true) {
    const target = path.join(dir, candidate)
    try {
      await fs.access(target)
      candidate = `${parsed.name}-${index}${parsed.ext}`
      index += 1
    } catch {
      return target
    }
  }
}

async function uniquePathWithNumberSuffix(dir, wantedName) {
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

function projectRelative(projectId, fullPath) {
  return path.relative(projectPath(projectId), fullPath).split(path.sep).join("/")
}

function docRelative(docId, fullPath) {
  return path.relative(docPath(docId), fullPath).split(path.sep).join("/")
}

function resolveProjectFile(projectId, relativePath) {
  const root = projectPath(projectId)
  const fullPath = path.resolve(root, relativePath)
  const relative = path.relative(root, fullPath)

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Invalid file path"), { statusCode: 400 })
  }

  return fullPath
}

function resolveProjectSubdirFile(projectId, relativePath, subdirName, invalidMessage, isIndexPath) {
  const raw = String(relativePath)
  let decodedPath

  try {
    decodedPath = decodeURIComponent(raw)
  } catch {
    throw Object.assign(new Error("Invalid file path encoding"), { statusCode: 400 })
  }

  const normalizedInput = decodedPath.split("\\").join("/")
  const prefixedPath = normalizedInput.includes("/") ? normalizedInput : `${subdirName}/${normalizedInput}`
  const normalizedPath = path.posix.normalize(prefixedPath)
  const subdirRoot = path.join(projectPath(projectId), subdirName)

  if (
    normalizedPath === `${subdirName}` ||
    normalizedPath === "" ||
    !normalizedPath.startsWith(`${subdirName}/`) ||
    isIndexPath?.(normalizedPath)
  ) {
    throw Object.assign(new Error(invalidMessage), { statusCode: 400 })
  }

  if (path.isAbsolute(normalizedInput)) {
    throw Object.assign(new Error(invalidMessage), { statusCode: 400 })
  }

  const fullPath = resolveProjectFile(projectId, normalizedPath)
  const relative = path.relative(subdirRoot, fullPath)

  if (relative === "" || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error(invalidMessage), { statusCode: 400 })
  }

  return fullPath
}

function resolveDocFile(docId, relativePath) {
  const root = docPath(docId)
  const fullPath = path.resolve(root, relativePath)
  const relative = path.relative(root, fullPath)

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Invalid file path"), { statusCode: 400 })
  }

  return fullPath
}

async function listProjectFiles(projectId, dirName) {
  const dir = path.join(projectPath(projectId), dirName)

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const files = await Promise.all(
      entries
        .filter((entry) => {
          if (!entry.isFile()) return false
          if (dirName === "artifacts" && isArtifactIndexName(entry.name)) return false
          if (dirName === "plan" && isPlanIndexName(entry.name)) return false
          return true
        })
        .map(async (entry) => {
          const fullPath = path.join(dir, entry.name)
          const stat = await fs.stat(fullPath)
          let title = null
          let owner = null
          let deadline = null
          let createdAt = null

          if (isMarkdownName(entry.name)) {
            try {
              const parsed = parseFrontmatter(await safeReadTextFile(fullPath))
              title = String(parsed.fields.title ?? "").trim() || titleFromMarkdown(parsed.body)
              owner = String(parsed.fields.owner ?? "").trim() || null
              deadline = String(parsed.fields.deadline ?? "").trim() || null
              createdAt = String(parsed.fields.createdAt ?? "").trim() || null
            } catch {
              title = null
            }
          } else if (isExcalidrawName(entry.name)) {
            try {
              const parsed = JSON.parse(await safeReadTextFile(fullPath))
              title = String(parsed?.appState?.name ?? "").trim() || null
            } catch {
              title = null
            }
          }

          return {
            name: entry.name,
            path: projectRelative(projectId, fullPath),
            kind: dirName,
            size: stat.size,
            title,
            owner,
            deadline,
            createdAt,
            updatedAt: stat.mtime.toISOString(),
          }
        })
    )

    return files.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  } catch (error) {
    if (error.code === "ENOENT") {
      return []
    }

    throw error
  }
}

async function listDocFiles(docId) {
  const dir = docPath(docId)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const fullPath = path.join(dir, entry.name)
        const stat = await fs.stat(fullPath)
        let title = null

        if (path.extname(entry.name).toLowerCase() === ".md") {
          try {
            title = titleFromMarkdown(parseFrontmatter(await safeReadTextFile(fullPath)).body)
          } catch {
            title = null
          }
        }

        return {
          name: entry.name,
          path: docRelative(docId, fullPath),
          kind: "docs",
          size: stat.size,
          title,
          updatedAt: stat.mtime.toISOString(),
        }
      })
  )

  return files.sort((left, right) => {
    if (left.name === "README.md") return -1
    if (right.name === "README.md") return 1
    return left.name.localeCompare(right.name)
  })
}

function titleFromMarkdown(markdown) {
  return String(markdown).match(/^#\s+(.+)\s*$/m)?.[1]?.trim() || null
}

function yamlValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`
}

function serializeFrontmatter(fields = {}) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${yamlValue(Array.isArray(value) ? value.join(", ") : value)}`)
    .join("\n")
}

function parseFrontmatter(raw) {
  const match = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)

  if (!match) {
    return {
      fields: {},
      body: String(raw),
    }
  }

  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
    if (!item) {
      continue
    }

    fields[item[1]] = item[2].replace(/^"(.*)"$/, "$1").replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
  }

  return {
    fields,
    body: String(raw).slice(match[0].length),
  }
}

function markdownWithFrontmatter(body, fields = {}) {
  const frontmatter = serializeFrontmatter(fields)
  return ["---", frontmatter, "---", "", body.trim(), ""].join("\n")
}

function markdownDocument(title, body, fields = {}) {
  return markdownWithFrontmatter(`# ${title}\n\n${body.trim()}`, fields)
}

function normalizeIndexPath(value, dirName, readmeName) {
  const raw = String(value ?? "").trim().replace(/^\.?\//, "").replace(new RegExp(`^${dirName}/`), "")
  let decoded = raw

  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }

  const fileName = path.basename(decoded)
  return fileName && fileName.toLowerCase() !== readmeName ? `${dirName}/${fileName}` : ""
}

function parseIndexSuffix(value) {
  const parts = String(value ?? "")
    .split(/\s+(?:—|-)\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  let owner = ""
  let deadline = ""

  for (const part of parts) {
    const due = part.match(/^(?:due|deadline):?\s*(\d{4}-\d{2}-\d{2})$/i)
    if (due) {
      deadline = due[1]
    } else if (!owner) {
      owner = part
    }
  }

  return { owner, deadline }
}

function parseIndexItems(raw, dirName, readmeName) {
  const items = []
  const matcher = /^-[ \t]+(?:\[([ xX])\][ \t]+)?\[([^\]\r\n]*)\]\(([^)\r\n]+)\)(?:[ \t]+(?:—|-)[ \t]*(.+?))?[ \t]*$/gm
  let match

  while ((match = matcher.exec(String(raw)))) {
    const itemPath = normalizeIndexPath(match[3], dirName, readmeName)
    if (!itemPath) {
      continue
    }

    const suffix = parseIndexSuffix(match[4])
    items.push({
      path: itemPath,
      title: match[2].trim(),
      done: match[1] ? match[1].toLowerCase() === "x" : false,
      owner: suffix.owner,
      deadline: suffix.deadline,
    })
  }

  return items
}

function indexedFileTitle(file) {
  return file.title?.trim() || path.parse(file.name).name.replace(/[-_]+/g, " ").trim() || file.name
}

function buildIndexContent({
  title,
  files,
  preferredItems = [],
  dirName,
  readmeName,
  checkboxes = false,
  owners = false,
  deadlines = false,
  preserveItemTitle = true,
  preserveItemOwner = true,
  preserveItemDeadline = true,
}) {
  const filesByPath = new Map(files.map((file) => [file.path, file]))
  const used = new Set()
  const ordered = []

  for (const item of preferredItems) {
    const itemPath = normalizeIndexPath(item.path, dirName, readmeName)
    const file = filesByPath.get(itemPath)

    if (!file || used.has(itemPath)) {
      continue
    }

    ordered.push({
      file,
      done: Boolean(item.done),
      title: String(item.title ?? "").trim() || null,
      owner: String(item.owner ?? "").trim() || null,
      deadline: String(item.deadline ?? "").trim() || null,
    })
    used.add(itemPath)
  }

  for (const file of files) {
    if (!used.has(file.path)) {
      ordered.push({ file, done: false, title: null, owner: null, deadline: null })
    }
  }

  const lines = [`# ${title}`, ""]

  for (const item of ordered) {
    const prefix = checkboxes ? `[${item.done ? "x" : " "}] ` : ""
    const itemTitle = preserveItemTitle && item.title && !isExcalidrawName(item.file.name)
      ? item.title
      : indexedFileTitle(item.file)
    const owner = owners ? preserveItemOwner && item.owner ? item.owner : item.file.owner : ""
    const deadline = deadlines ? preserveItemDeadline && item.deadline ? item.deadline : item.file.deadline : ""
    const suffixParts = [
      owner ? markdownLinkLabel(owner) : "",
      deadline ? `due ${markdownLinkLabel(deadline)}` : "",
    ].filter(Boolean)
    const suffix = suffixParts.length ? ` — ${suffixParts.join(" — ")}` : ""
    lines.push(`- ${prefix}[${markdownLinkLabel(itemTitle)}](${encodeURI(item.file.name)})${suffix}`)
  }

  return `${lines.join("\n").trimEnd()}\n`
}

function normalizePlanIndexPath(value) {
  return normalizeIndexPath(value, "plan", PLAN_README_FILE.toLowerCase())
}

function parsePlanIndexItems(raw) {
  return parseIndexItems(raw, "plan", PLAN_README_FILE.toLowerCase())
}

function markdownLinkLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("]", "\\]").replace(/\s+/g, " ").trim()
}

function buildPlanIndexContent(files, preferredItems = []) {
  return buildIndexContent({
    title: "Plan",
    files,
    preferredItems,
    dirName: "plan",
    readmeName: PLAN_README_FILE.toLowerCase(),
    checkboxes: true,
    owners: true,
    deadlines: true,
    preserveItemTitle: false,
    preserveItemOwner: false,
    preserveItemDeadline: false,
  })
}

async function readPlanIndexItems(projectId) {
  try {
    return parsePlanIndexItems(await safeReadTextFile(planIndexPath(projectId)))
  } catch (error) {
    if (error.code === "ENOENT") {
      return []
    }

    throw error
  }
}

async function readArtifactIndexItems(projectId) {
  try {
    return parseIndexItems(await safeReadTextFile(artifactIndexPath(projectId)), "artifacts", ARTIFACTS_README_FILE)
  } catch (error) {
    if (error.code === "ENOENT") {
      return []
    }

    throw error
  }
}

export async function ensureArtifactIndex(projectId) {
  await ensureProjectDirs(projectId)

  const files = await listProjectFiles(projectId, "artifacts")
  const content = buildIndexContent({
    title: "Artifacts",
    files,
    preferredItems: await readArtifactIndexItems(projectId),
    dirName: "artifacts",
    readmeName: ARTIFACTS_README_FILE,
  })
  const target = artifactIndexPath(projectId)

  try {
    if ((await safeReadTextFile(target)) === content) {
      return {
        path: `artifacts/${ARTIFACTS_README_FILE}`,
        content,
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }

  await safeWriteTextFile(target, content)

  return {
    path: `artifacts/${ARTIFACTS_README_FILE}`,
    content,
  }
}

async function migrateLegacyPlan(projectId) {
  const root = projectPath(projectId)
  const legacyDir = legacyPlanDirPath(projectId)
  const planDir = path.join(root, "plan")
  let hasLegacy = false
  let hasPlanContent = false

  try {
    const stat = await fs.lstat(legacyDir)

    if (stat.isSymbolicLink()) {
      throw storagePathError()
    }

    hasLegacy = stat.isDirectory()
    if (hasLegacy) {
      await assertRealPathInside(vaultDir, legacyDir)
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }

  try {
    const stat = await fs.lstat(planDir)

    if (stat.isSymbolicLink()) {
      throw storagePathError()
    }

    const planEntries = stat.isDirectory() ? await fs.readdir(planDir) : []
    hasPlanContent = planEntries.some((name) => name !== ".DS_Store")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }

  if (!hasLegacy || hasPlanContent) {
    return
  }

  try {
    await fs.rename(legacyDir, planDir)
  } catch (error) {
    if (!["EXDEV", "ENOTEMPTY", "EEXIST"].includes(error.code)) {
      throw error
    }
    await fs.cp(legacyDir, planDir, { recursive: true, force: false, errorOnExist: false })
    await fs.rm(legacyDir, { recursive: true, force: true })
  }

  const legacyReadme = path.join(planDir, LEGACY_PLAN_README_FILE)
  const planReadme = path.join(planDir, PLAN_README_FILE)

  try {
    const raw = await safeReadTextFile(legacyReadme)
    const next = raw
      .replace(/^#\s+Tasks\s*$/im, "# Plan")
      .replace(/\]\((?:tasks\/)?([^)]+)\)/g, "]($1)")

    await safeWriteTextFile(planReadme, next)
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }
}

export async function ensurePlanIndex(projectId) {
  await ensureProjectDirs(projectId)
  await migrateLegacyPlan(projectId)

  const files = await listProjectFiles(projectId, "plan")
  const content = buildPlanIndexContent(files, await readPlanIndexItems(projectId))
  const target = planIndexPath(projectId)

  try {
    if ((await safeReadTextFile(target)) === content) {
      return {
        path: `plan/${PLAN_README_FILE}`,
        content,
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }

  await safeWriteTextFile(target, content)

  return {
    path: `plan/${PLAN_README_FILE}`,
    content,
  }
}

function summarizeContent(content) {
  const firstLine = content.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "update"
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine
}

function activityFileName(index) {
  return `${String(index).padStart(6, "0")}.md`
}

function activityFileIndex(fileName) {
  const value = Number.parseInt(path.basename(fileName, ".md"), 10)
  return Number.isFinite(value) && value > 0 ? value : 1
}

function isActivitySegmentName(fileName) {
  return /^\d{6}\.md$/.test(fileName)
}

function activityEntryId(fileName, index, fallback = "") {
  return fallback || `${fileName ?? "activity"}:${index + 1}`
}

function activityHeadingDate(value) {
  const date = new Date(value)
  const pad = (item) => String(item).padStart(2, "0")

  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join(" ")
}

function parseActivityHeadingDate(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/)

  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5])
    ).toISOString()
  }

  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ""
}

function activityMarkdownBlock(entry) {
  return [`## ${activityHeadingDate(entry.createdAt)} - ${entry.author}`, "", String(entry.content ?? "").trim(), ""].join("\n")
}

function activityFileContent(entries) {
  const body = entries.map(activityMarkdownBlock).join("\n").trimEnd()
  return body ? `# Activity Log\n\n${body}\n` : "# Activity Log\n\n"
}

function extractActivityArtifactPath(content) {
  const match = String(content).match(/\]\((?:\.\.\/)?(artifacts\/[^)#]+)(?:#[^)]+)?\)/)
  return match ? match[1] : null
}

async function listActivitySegmentFiles(projectId) {
  try {
    const entries = await fs.readdir(activityLogDirPath(projectId), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && isActivitySegmentName(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    if (error.code === "ENOENT") {
      return []
    }

    throw error
  }
}

async function ensureActivityLog(projectId) {
  const dir = activityLogDirPath(projectId)
  await ensureSafeDir(dir)

  const files = await listActivitySegmentFiles(projectId)
  if (files.length > 0) {
    return
  }

  let legacyEntries = []

  try {
    legacyEntries = parseActivityEntries(await safeReadTextFile(legacyActivityLogPath(projectId)))
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }

  if (legacyEntries.length === 0) {
    await safeWriteTextFile(activitySegmentPath(projectId, activityFileName(1)), activityFileContent([]))
    return
  }

  for (let index = 0; index < legacyEntries.length; index += ACTIVITY_LOG_ENTRIES_PER_FILE) {
    const fileName = activityFileName(index / ACTIVITY_LOG_ENTRIES_PER_FILE + 1)
    const entries = legacyEntries.slice(index, index + ACTIVITY_LOG_ENTRIES_PER_FILE)
    await safeWriteTextFile(activitySegmentPath(projectId, fileName), activityFileContent(entries))
  }
}

function parseLegacyActivityEntries(raw, options = {}) {
  return raw
    .split(/(?=<!-- devsync:entry )/g)
    .map((chunk, index) => {
      const markerMatch = chunk.match(/^<!-- devsync:entry (.*?) -->\s*/)

      if (!markerMatch) {
        return null
      }

      let meta
      try {
        meta = JSON.parse(markerMatch[1])
      } catch {
        return null
      }

      const body = chunk.slice(markerMatch[0].length).trim()
      const headingMatch = body.match(/^##\s+(.+)\s*/)
      const content = headingMatch ? body.slice(headingMatch[0].length).trim() : body

      return {
        id: String(meta.id ?? ""),
        createdAt: String(meta.createdAt ?? ""),
        author: String(meta.author ?? "team"),
        kind: meta.kind === "artifact" ? "artifact" : "inline",
        artifactPath: meta.artifactPath ? String(meta.artifactPath) : null,
        title: String(meta.title ?? headingMatch?.[1] ?? "Update"),
        content,
      }
    })
    .filter(Boolean)
    .map((entry, index) => ({
      ...entry,
      id: activityEntryId(options.fileName, index, entry.id),
    }))
}

function parseMarkdownActivityEntries(raw, options = {}) {
  const headings = []
  const matcher = /^##\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+-\s+(.+?)\s*$/gm
  let match

  while ((match = matcher.exec(raw))) {
    headings.push({
      at: match.index,
      end: matcher.lastIndex,
      createdAt: parseActivityHeadingDate(match[1]),
      author: match[2].trim() || "team",
    })
  }

  return headings.map((heading, index) => {
    const next = headings[index + 1]
    const content = raw.slice(heading.end, next?.at ?? raw.length).trim()
    const artifactPath = extractActivityArtifactPath(content)

    return {
      id: activityEntryId(options.fileName, index),
      createdAt: heading.createdAt,
      author: heading.author,
      kind: artifactPath ? "artifact" : "inline",
      artifactPath,
      title: summarizeContent(content),
      content,
    }
  })
}

function parseActivityEntries(raw, options = {}) {
  const legacyEntries = parseLegacyActivityEntries(raw, options)

  if (legacyEntries.length > 0) {
    return legacyEntries
  }

  return parseMarkdownActivityEntries(raw, options)
}

async function appendActivityEntry(projectId, input) {
  await ensureProjectDirs(projectId)
  await ensureActivityLog(projectId)

  const createdAt = input.createdAt ?? nowIso()
  const author = String(input.author ?? "team").trim() || "team"
  const content = String(input.content ?? "").trim()
  const title = String(input.title ?? summarizeContent(content)).trim() || "update"
  const files = await listActivitySegmentFiles(projectId)
  let fileName = files.at(-1) ?? activityFileName(1)
  let target = activitySegmentPath(projectId, fileName)
  let raw = await safeReadTextFile(target).catch((error) => {
    if (error.code === "ENOENT") {
      return activityFileContent([])
    }
    throw error
  })
  let entries = parseActivityEntries(raw, { fileName })

  if (entries.length >= ACTIVITY_LOG_ENTRIES_PER_FILE) {
    fileName = activityFileName(activityFileIndex(fileName) + 1)
    target = activitySegmentPath(projectId, fileName)
    raw = activityFileContent([])
    entries = []
    await safeWriteTextFile(target, raw)
  }

  const entry = {
    id: activityEntryId(fileName, entries.length),
    createdAt,
    author,
    kind: input.kind === "artifact" ? "artifact" : "inline",
    artifactPath: input.artifactPath ?? null,
    title,
    content,
  }
  const separator = raw.endsWith("\n\n") ? "" : raw.endsWith("\n") ? "\n" : "\n\n"

  await safeAppendTextFile(target, `${separator}${activityMarkdownBlock(entry)}`)
  return {
    ...entry,
    path: `logs/${ACTIVITY_LOG_DIR}/${fileName}`,
  }
}

export async function getActivityLog(projectId, options = {}) {
  const requestedFileCount = Number(options.files ?? DEFAULT_ACTIVITY_LOG_FILES)
  const fileCount =
    Number.isFinite(requestedFileCount) && requestedFileCount > 0
      ? Math.floor(requestedFileCount)
      : DEFAULT_ACTIVITY_LOG_FILES

  await ensureProjectDirs(projectId)
  await ensureActivityLog(projectId)

  const files = await listActivitySegmentFiles(projectId)
  const before = options.before ? path.basename(String(options.before)) : null
  const endIndex = before ? files.indexOf(before) : files.length

  if (before && endIndex === -1) {
    throw Object.assign(new Error("Unknown activity file"), { statusCode: 400 })
  }

  const selectedFiles = files.slice(Math.max(0, endIndex - fileCount), endIndex)
  const entries = []

  for (const fileName of selectedFiles) {
    const raw = await safeReadTextFile(activitySegmentPath(projectId, fileName))
    entries.push(...parseActivityEntries(raw, { fileName }))
  }

  return {
    path: `logs/${ACTIVITY_LOG_DIR}`,
    files: selectedFiles,
    oldestFile: selectedFiles[0] ?? null,
    newestFile: selectedFiles.at(-1) ?? null,
    hasOlder: selectedFiles.length > 0 && files.indexOf(selectedFiles[0]) > 0,
    entries,
  }
}

export async function listNewsEntries() {
  const limit = 200
  await ensureDataDir()
  const entries = await fs.readdir(dataDir, { withFileTypes: true })
  const items = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    try {
      const metadata = await getProjectMetadata(entry.name)
      await ensureActivityLog(entry.name)
      const files = await listActivitySegmentFiles(entry.name)

      for (const fileName of files) {
        const raw = await safeReadTextFile(activitySegmentPath(entry.name, fileName))
        items.push(
          ...parseActivityEntries(raw, { fileName }).map((activityEntry) => ({
            ...activityEntry,
            id: `${metadata.id}:${activityEntry.id}`,
            projectId: metadata.id,
            projectName: metadata.name,
          }))
        )
      }
    } catch {
      continue
    }
  }

  return items.sort((left, right) => {
    const byDate = left.createdAt.localeCompare(right.createdAt)
    if (byDate !== 0) return byDate

    const byProject = left.projectName.localeCompare(right.projectName)
    return byProject !== 0 ? byProject : left.id.localeCompare(right.id)
  }).slice(-limit)
}

export async function ensureDataDir() {
  await ensureSafeDir(vaultDir)
  await ensureSafeDir(dataDir)
  await ensureSafeDir(docsDir)
  await ensureSafeDir(path.join(vaultDir, "roles"))
  await ensureSafeDir(path.join(vaultDir, "automations"))
}

export async function getPlanningGantt() {
  await ensureDataDir()

  try {
    return normalizeGanttData(await readJson(planningPath))
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }

    try {
      return normalizeGanttData(await readJson(legacyGanttPath))
    } catch (legacyError) {
      if (legacyError.code === "ENOENT") {
        return normalizeGanttData()
      }

      throw legacyError
    }
  }
}

export async function updatePlanningGantt(input = {}) {
  await ensureDataDir()

  const data = normalizeGanttData({
    tasks: input.tasks,
    links: input.links,
    updatedAt: nowIso(),
  })

  await safeWriteTextFile(planningPath, `${JSON.stringify(data, null, 2)}\n`)
  await appendSystemLogEvent({
    action: "vault_plan.updated",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId: null,
    target: PLANNING_FILE,
    summary: `Updated vault plan (${data.tasks.length} tasks)`,
  })

  return data
}

export async function listDocs() {
  await ensureDataDir()
  const entries = await fs.readdir(docsDir, { withFileTypes: true })
  const docs = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    try {
      assertDocId(entry.name)
      const folder = docPath(entry.name)
      const [stat, files] = await Promise.all([fs.stat(folder), listDocFiles(entry.name)])

      docs.push({
        id: entry.name,
        name: entry.name,
        updatedAt: stat.mtime.toISOString(),
        counts: {
          files: files.length,
        },
      })
    } catch {
      continue
    }
  }

  return docs.sort((left, right) => left.name.localeCompare(right.name))
}

export async function getDocFolder(docId) {
  const root = docPath(docId)
  await assertRealPathInside(vaultDir, root)
  const stat = await fs.lstat(root)

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw Object.assign(new Error("Docs folder not found"), { statusCode: 404 })
  }

  const files = await listDocFiles(docId)
  let readme = ""

  try {
    readme = await safeReadTextFile(path.join(root, "README.md"))
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }

  return {
    id: docId,
    name: docId,
    updatedAt: stat.mtime.toISOString(),
    readme,
    files,
    counts: {
      files: files.length,
    },
  }
}

export async function getProjectMetadata(projectId) {
  let metadata

  try {
    metadata = await readJson(metadataPath(projectId))
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }

    metadata = await inferProjectMetadata(projectId)
    await writeProjectMetadata(projectId, metadata)
  }

  return {
    id: projectId,
    name: humanizeProjectId(projectId),
    owner: metadata.owner ?? "",
    status: metadata.status ?? "active",
    tags: normalizeList(metadata.tags),
    createdAt: metadata.createdAt ?? nowIso(),
    updatedAt: metadata.updatedAt ?? metadata.createdAt ?? nowIso(),
  }
}

export async function listProjects() {
  await ensureDataDir()
  const entries = await fs.readdir(dataDir, { withFileTypes: true })
  const projects = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    try {
      const metadata = await getProjectMetadata(entry.name)
      await ensurePlanIndex(entry.name)
      const [artifacts, generated, planItems, activity] = await Promise.all([
        listProjectFiles(entry.name, "artifacts"),
        listProjectFiles(entry.name, "generated"),
        listProjectFiles(entry.name, "plan"),
        getActivityLog(entry.name),
      ])

      projects.push({
        ...metadata,
        counts: {
          artifacts: artifacts.length,
          logs: activity.entries.length,
          generated: generated.length,
          planItems: planItems.length,
        },
      })
    } catch {
      continue
    }
  }

  return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export async function createProject(input) {
  await ensureDataDir()

  const name = String(input?.name ?? "").trim()
  if (!name) {
    throw Object.assign(new Error("Project name is required"), { statusCode: 400 })
  }

  const projectId = slugify(input.slug ?? name)
  const displayName = humanizeProjectId(projectId)
  const root = projectPath(projectId)

  try {
    await fs.access(root)
    throw Object.assign(new Error("Project already exists"), { statusCode: 409 })
  } catch (error) {
    if (error.statusCode === 409) {
      throw error
    }
  }

  await ensureProjectDirs(projectId)

  const timestamp = nowIso()
  const metadata = {
    owner: String(input.owner ?? "").trim(),
    status: String(input.status ?? "active").trim() || "active",
    tags: normalizeList(input.tags),
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  await writeProjectMetadata(projectId, metadata)
  await ensureActivityLog(projectId)
  await ensureArtifactIndex(projectId)
  await ensurePlanIndex(projectId)
  await safeWriteTextFile(
    path.join(root, "README.md"),
    markdownDocument(displayName, "Project notes start here.", { owner: metadata.owner, status: metadata.status })
  )
  await appendSystemLogEvent({
    action: "project.created",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.creator ?? "team",
    projectId,
    target: "project.json",
    summary: `Created project ${displayName}`,
  })

  return getProject(projectId)
}

export async function updateProject(projectId, input) {
  await ensureProjectDirs(projectId)
  const current = await getProjectMetadata(projectId)
  let nextProjectId = projectId

  if (input.name !== undefined) {
    const nextName = String(input.name).trim()

    if (!nextName) {
      throw Object.assign(new Error("Project name is required"), { statusCode: 400 })
    }

    const candidateProjectId = slugify(nextName)
    nextProjectId = candidateProjectId === slugify(projectId) ? projectId : candidateProjectId
  }

  const metadata = {
    owner: input.owner === undefined ? current.owner : String(input.owner).trim(),
    status: input.status === undefined ? current.status : String(input.status).trim(),
    tags: input.tags === undefined ? current.tags : normalizeList(input.tags),
    createdAt: current.createdAt,
    updatedAt: nowIso(),
  }

  if (nextProjectId !== projectId) {
    const nextRoot = projectPath(nextProjectId)

    try {
      await fs.access(nextRoot)
      throw Object.assign(new Error("Project already exists"), { statusCode: 409 })
    } catch (error) {
      if (error.statusCode === 409) {
        throw error
      }
      if (error.code !== "ENOENT") {
        throw error
      }
    }

    await fs.rename(projectPath(projectId), nextRoot)
  }

  await writeProjectMetadata(nextProjectId, metadata)
  await appendSystemLogEvent({
    action: nextProjectId === projectId ? "project.updated" : "project.renamed",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId: nextProjectId,
    target: "project.json",
    summary: nextProjectId === projectId
      ? `Updated project ${humanizeProjectId(nextProjectId)}`
      : `Renamed project ${projectId} to ${nextProjectId}`,
  })
  return getProject(nextProjectId)
}

export async function getProject(projectId, options = {}) {
  await ensureProjectDirs(projectId)
  await ensureActivityLog(projectId)
  await ensureArtifactIndex(projectId)
  await ensurePlanIndex(projectId)
  const [metadata, artifacts, logs, generated, planItems, activity] = await Promise.all([
    getProjectMetadata(projectId),
    listProjectFiles(projectId, "artifacts"),
    listProjectFiles(projectId, "logs"),
    listProjectFiles(projectId, "generated"),
    listProjectFiles(projectId, "plan"),
    getActivityLog(projectId, { files: options.activityFiles }),
  ])

  return {
    ...metadata,
    activity,
    files: {
      artifacts,
      logs,
      generated,
      plan: planItems,
    },
    counts: {
      artifacts: artifacts.length,
      logs: activity.entries.length,
      generated: generated.length,
      planItems: planItems.length,
    },
  }
}

export async function addTextArtifact(projectId, input) {
  await ensureProjectDirs(projectId)
  const title = String(input?.title ?? "Note").trim() || "Note"
  const content = String(input?.content ?? "").trim()
  const created = nowIso()
  const creator = String(input?.author ?? input?.creator ?? "team").trim() || "team"

  if (!content) {
    throw Object.assign(new Error("Content is required"), { statusCode: 400 })
  }

  const dir = path.join(projectPath(projectId), "artifacts")
  const target = await uniquePathWithNumberSuffix(dir, `${dateStamp(new Date(created))}-${slugify(title)}.md`)
  const document = markdownDocument(title, content, {
    type: "text",
    created,
    creator,
    lastEdited: created,
    lastEditor: creator,
  })
  await safeWriteTextFile(target, document)
  const relativePath = projectRelative(projectId, target)
  await appendActivityEntry(projectId, {
    author: creator,
    kind: "artifact",
    artifactPath: relativePath,
    title: `Added ${title}`,
    content: `Added artifact [${markdownLinkLabel(title)}](../${relativePath}).`,
  })
  await ensureArtifactIndex(projectId)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.created",
    source: input?.source ?? "storage",
    actor: creator,
    projectId,
    target: relativePath,
    summary: `Added text artifact ${title}`,
  })
  await appendMentionEventsForWrite(projectId, relativePath, "", document, input, "artifact")

  return {
    name: path.basename(target),
    path: relativePath,
  }
}

export async function addLinkArtifact(projectId, input) {
  await ensureProjectDirs(projectId)
  const url = String(input?.url ?? "").trim()

  if (!/^https?:\/\//i.test(url)) {
    throw Object.assign(new Error("A valid http(s) URL is required"), { statusCode: 400 })
  }

  const title = String(input?.title ?? new URL(url).hostname).trim()
  const notes = String(input?.notes ?? "").trim()
  const created = nowIso()
  const creator = String(input?.author ?? input?.creator ?? "team").trim() || "team"
  const body = [`Source: ${url}`, notes ? `\n${notes}` : ""].join("\n")
  const dir = path.join(projectPath(projectId), "artifacts")
  const target = await uniquePathWithNumberSuffix(dir, `${dateStamp(new Date(created))}-${slugify(title)}.md`)
  const document = markdownDocument(title, body, {
    type: "link",
    sourceUrl: url,
    created,
    creator,
    lastEdited: created,
    lastEditor: creator,
  })

  await safeWriteTextFile(target, document)
  const relativePath = projectRelative(projectId, target)
  await appendActivityEntry(projectId, {
    author: creator,
    kind: "artifact",
    artifactPath: relativePath,
    title: `Added ${title}`,
    content: `Added artifact [${markdownLinkLabel(title)}](../${relativePath}).`,
  })
  await ensureArtifactIndex(projectId)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.created",
    source: input?.source ?? "storage",
    actor: creator,
    projectId,
    target: relativePath,
    summary: `Added link artifact ${title}`,
    metadata: { sourceUrl: url },
  })
  await appendMentionEventsForWrite(projectId, relativePath, "", document, input, "artifact")

  return {
    name: path.basename(target),
    path: relativePath,
  }
}

function normalizeExcalidrawContent(content, title = "") {
  const raw = String(content ?? "").trim()
  let data = {
    type: "excalidraw",
    version: 2,
    source: "devsync",
    elements: [],
    appState: {},
    files: {},
  }

  if (raw) {
    try {
      data = JSON.parse(raw)
    } catch {
      throw Object.assign(new Error("Invalid Excalidraw JSON"), { statusCode: 400 })
    }
  }

  if (!isPlainObject(data)) {
    throw Object.assign(new Error("Invalid Excalidraw JSON"), { statusCode: 400 })
  }

  if (data.elements !== undefined && !Array.isArray(data.elements)) {
    throw Object.assign(new Error("Invalid Excalidraw elements"), { statusCode: 400 })
  }

  if (data.appState !== undefined && !isPlainObject(data.appState)) {
    throw Object.assign(new Error("Invalid Excalidraw appState"), { statusCode: 400 })
  }

  if (data.files !== undefined && !isPlainObject(data.files)) {
    throw Object.assign(new Error("Invalid Excalidraw files"), { statusCode: 400 })
  }

  const name = String(title || data.appState?.name || "Drawing").trim() || "Drawing"
  const normalized = {
    ...data,
    type: String(data.type ?? "excalidraw"),
    version: Number.isFinite(Number(data.version)) ? Number(data.version) : 2,
    source: String(data.source ?? "devsync"),
    elements: Array.isArray(data.elements) ? data.elements : [],
    appState: {
      ...(isPlainObject(data.appState) ? data.appState : {}),
      name,
    },
    files: isPlainObject(data.files) ? data.files : {},
  }

  return `${JSON.stringify(normalized, null, 2)}\n`
}

export async function addExcalidrawArtifact(projectId, input = {}) {
  await ensureProjectDirs(projectId)
  const title = String(input?.title ?? "Drawing").trim() || "Drawing"
  const created = nowIso()
  const creator = String(input?.author ?? input?.creator ?? "team").trim() || "team"
  const content = normalizeExcalidrawContent(input?.content, title)
  const dir = path.join(projectPath(projectId), "artifacts")
  const target = await uniquePathWithNumberSuffix(dir, `${dateStamp(new Date(created))}-${slugify(title)}${EXCALIDRAW_EXTENSION}`)

  await safeWriteTextFile(target, content)

  const relativePath = projectRelative(projectId, target)
  await appendActivityEntry(projectId, {
    author: creator,
    kind: "artifact",
    artifactPath: relativePath,
    title: `Added ${title}`,
    content: `Added drawing [${markdownLinkLabel(title)}](../${relativePath}).`,
  })
  await ensureArtifactIndex(projectId)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.created",
    source: input?.source ?? "storage",
    actor: creator,
    projectId,
    target: relativePath,
    summary: `Added Excalidraw artifact ${title}`,
  })

  return {
    name: path.basename(target),
    path: relativePath,
  }
}

function normalizePlanDeadline(value) {
  const deadline = String(value ?? "").trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : ""
}

function sanitizePlanItemFields(fields = {}) {
  return {
    title: String(fields.title ?? "").trim(),
    createdAt: String(fields.createdAt ?? "").trim(),
    createdBy: String(fields.createdBy ?? "").trim(),
    owner: String(fields.owner ?? "").trim(),
    deadline: normalizePlanDeadline(fields.deadline),
  }
}

function planItemContent(title, body, fields) {
  return markdownWithFrontmatter(`# ${title}\n\n${String(body ?? "").trim()}`, sanitizePlanItemFields(fields))
}

function planItemBodyWithoutTitle(body) {
  return String(body ?? "").trimStart().replace(/^#\s+.*(?:\r?\n|$)/, "").trim()
}

function normalizePlanBody(body, title) {
  const content = String(body ?? "").trim()
  return content ? content : ""
}

async function appendMentionEventsForWrite(projectId, target, before, after, input = {}, targetType) {
  await appendMentionEvents({
    actor: String(input?.author ?? input?.editor ?? input?.creator ?? input?.createdBy ?? "team").trim() || "team",
    after,
    before,
    projectId,
    source: input?.source ?? "storage",
    target,
    targetType,
  })
}

export async function createPlanItem(projectId, input) {
  await ensureProjectDirs(projectId)
  await ensurePlanIndex(projectId)

  const title = String(input?.title ?? "").trim()
  const content = String(input?.content ?? input?.body ?? "").trim()
  const created = nowIso()
  const creator = String(input?.createdBy ?? input?.author ?? input?.creator ?? "team").trim() || "team"
  const owner = String(input?.owner ?? "").trim()
  const deadline = normalizePlanDeadline(input?.deadline)

  if (!title) {
    throw Object.assign(new Error("Plan item title is required"), { statusCode: 400 })
  }

  const dir = path.join(projectPath(projectId), "plan")
  const target = await uniquePathWithNumberSuffix(dir, `${dateStamp(new Date(created))}-${slugify(title)}.md`)
  const document = planItemContent(title, normalizePlanBody(content, title), {
    title,
    createdAt: created,
    createdBy: creator,
    owner,
    deadline,
  })
  await safeWriteTextFile(target, document)
  const relativePath = projectRelative(projectId, target)
  await ensurePlanIndex(projectId)
  await appendActivityEntry(projectId, {
    createdAt: created,
    author: creator,
    title: `Created plan item ${title}`,
    content: `Created plan item: ${title} (${relativePath}).`,
  })
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "plan_item.created",
    source: input?.source ?? "storage",
    actor: creator,
    projectId,
    target: relativePath,
    summary: `Created plan item ${title}`,
  })
  await appendMentionEventsForWrite(projectId, relativePath, "", document, input, "plan")

  return {
    name: path.basename(target),
    path: relativePath,
  }
}

async function updatePlanItemFieldsFromIndex(projectId, item) {
  const title = String(item?.title ?? "").trim()
  const owner = String(item?.owner ?? "").trim()
  const deadline = normalizePlanDeadline(item?.deadline)

  const fullPath = resolvePlanItemFile(projectId, item.path)
  const existing = parseFrontmatter(await safeReadTextFile(fullPath))
  const existingFields = sanitizePlanItemFields(existing.fields)
  const currentTitle = titleFromPlanContent(existing, path.parse(fullPath).name)
  const nextTitle = title || currentTitle

  if (currentTitle === nextTitle && existingFields.owner === owner && existingFields.deadline === deadline) {
    return
  }

  const body = planItemBodyWithoutTitle(existing.body)
  const content = planItemContent(nextTitle, body, {
    ...existingFields,
    title: nextTitle,
    owner,
    deadline,
  })

  await safeWriteTextFile(fullPath, content)
}

export async function updatePlanIndex(projectId, input = {}) {
  await ensureProjectDirs(projectId)
  await ensurePlanIndex(projectId)

  const requestedItems = Array.isArray(input.items)
    ? input.items.map((item) => ({
        path: normalizePlanIndexPath(item?.path),
        title: String(item?.title ?? "").trim(),
        done: Boolean(item?.done),
        owner: String(item?.owner ?? "").trim(),
        deadline: normalizePlanDeadline(item?.deadline),
      }))
    : typeof input.content === "string"
      ? parsePlanIndexItems(input.content)
      : await readPlanIndexItems(projectId)

  await Promise.all(requestedItems.filter((item) => item.path).map((item) => updatePlanItemFieldsFromIndex(projectId, item)))

  const files = await listProjectFiles(projectId, "plan")
  const content = buildPlanIndexContent(files, requestedItems)
  const target = planIndexPath(projectId)
  const existingRaw = await safeReadTextFile(target).catch((error) => {
    if (error.code === "ENOENT") return ""
    throw error
  })

  await safeWriteTextFile(target, content)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "plan_index.updated",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: `plan/${PLAN_README_FILE}`,
    summary: "Updated plan index",
  })
  await appendMentionEventsForWrite(projectId, `plan/${PLAN_README_FILE}`, existingRaw, content, input, "plan")

  return {
    path: `plan/${PLAN_README_FILE}`,
    size: Buffer.byteLength(content, "utf8"),
    content,
  }
}

export async function updateArtifactIndex(projectId, input = {}) {
  await ensureProjectDirs(projectId)

  const files = await listProjectFiles(projectId, "artifacts")
  const requestedItems = Array.isArray(input.items)
    ? input.items.map((item) => ({
        path: normalizeIndexPath(item?.path, "artifacts", ARTIFACTS_README_FILE),
      }))
    : typeof input.content === "string"
      ? parseIndexItems(input.content, "artifacts", ARTIFACTS_README_FILE)
      : await readArtifactIndexItems(projectId)
  const content = buildIndexContent({
    title: "Artifacts",
    files,
    preferredItems: requestedItems,
    dirName: "artifacts",
    readmeName: ARTIFACTS_README_FILE,
  })
  const target = artifactIndexPath(projectId)
  const existingRaw = await safeReadTextFile(target).catch((error) => {
    if (error.code === "ENOENT") return ""
    throw error
  })

  await safeWriteTextFile(target, content)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact_index.updated",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: `artifacts/${ARTIFACTS_README_FILE}`,
    summary: "Updated artifact index",
  })
  await appendMentionEventsForWrite(projectId, `artifacts/${ARTIFACTS_README_FILE}`, existingRaw, content, input, "artifact")

  return {
    path: `artifacts/${ARTIFACTS_README_FILE}`,
    size: Buffer.byteLength(content, "utf8"),
    content,
  }
}

export async function addLog(projectId, input) {
  await ensureProjectDirs(projectId)
  await ensureActivityLog(projectId)
  const content = String(input?.content ?? "").trim()

  if (!content) {
    throw Object.assign(new Error("Log content is required"), { statusCode: 400 })
  }

  const createdAt = nowIso()
  const author = String(input?.author ?? "team").trim() || "team"
  const title = summarizeContent(content)
  let kind = "inline"
  let artifactPath = null
  let logContent = content

  if (content.length > ACTIVITY_INLINE_MAX_CHARS) {
    const dir = path.join(projectPath(projectId), "artifacts")
    const target = await uniquePath(dir, `${dateStamp(new Date(createdAt))}-${slugify(title)}.md`)
    const document = markdownDocument(title, content, {
      type: "activity-log",
      created: createdAt,
      creator: author,
      lastEdited: createdAt,
      lastEditor: author,
    })
    await safeWriteTextFile(target, document)
    kind = "artifact"
    artifactPath = projectRelative(projectId, target)
    logContent = `Long update archived as [${title}](../${artifactPath}).`
    await ensureArtifactIndex(projectId)
  }

  const entry = await appendActivityEntry(projectId, {
    createdAt,
    author,
    kind,
    artifactPath,
    title,
    content: logContent,
  })
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "activity_log.appended",
    source: input?.source ?? "storage",
    actor: author,
    projectId,
    target: entry.path,
    summary: title,
    metadata: { kind, artifactPath },
  })
  await appendMentionEventsForWrite(
    projectId,
    artifactPath ?? entry.path,
    "",
    content,
    { ...input, author },
    artifactPath ? "artifact" : "activity"
  )

  return entry
}

export async function saveUpload(projectId, filePart, input = {}) {
  await ensureProjectDirs(projectId)

  if (!filePart?.filename) {
    throw Object.assign(new Error("File is required"), { statusCode: 400 })
  }

  const dir = path.join(projectPath(projectId), "artifacts")
  const target = await uniquePath(dir, cleanFileName(filePart.filename))
  await safeUploadStream(target, filePart.file)
  const relativePath = projectRelative(projectId, target)
  await appendActivityEntry(projectId, {
    author: input.author ?? "team",
    kind: "artifact",
    artifactPath: relativePath,
    title: `Uploaded ${path.basename(target)}`,
    content: `Uploaded artifact [${path.basename(target)}](../${relativePath}).`,
  })
  await ensureArtifactIndex(projectId)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.uploaded",
    source: input?.source ?? "storage",
    actor: input.author ?? "team",
    projectId,
    target: relativePath,
    summary: `Uploaded artifact ${path.basename(target)}`,
  })

  return {
    name: path.basename(target),
    path: relativePath,
  }
}

function resolveArtifactFile(projectId, relativePath) {
  return resolveProjectSubdirFile(projectId, relativePath, "artifacts", "Only artifact files can be changed", isArtifactIndexPath)
}

function resolvePlanItemFile(projectId, relativePath) {
  return resolveProjectSubdirFile(projectId, relativePath, "plan", "Only plan item files can be changed", isPlanIndexPath)
}

function resolveGeneratedFile(projectId, relativePath) {
  return resolveProjectSubdirFile(projectId, relativePath, "generated", "Only generated files can be changed")
}

export async function deleteArtifact(projectId, relativePath) {
  await ensureProjectDirs(projectId)
  const fullPath = resolveArtifactFile(projectId, relativePath)
  await safeUnlinkFile(fullPath)
  await ensureArtifactIndex(projectId)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.deleted",
    source: "storage",
    actor: "team",
    projectId,
    target: projectRelative(projectId, fullPath),
    summary: `Deleted artifact ${path.basename(fullPath)}`,
  })

  return {
    path: relativePath,
    deleted: true,
  }
}

export async function deletePlanItem(projectId, relativePath) {
  await ensureProjectDirs(projectId)
  await ensurePlanIndex(projectId)
  const fullPath = resolvePlanItemFile(projectId, relativePath)
  await safeUnlinkFile(fullPath)
  await ensurePlanIndex(projectId)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "plan_item.deleted",
    source: "storage",
    actor: "team",
    projectId,
    target: projectRelative(projectId, fullPath),
    summary: `Deleted plan item ${path.basename(fullPath)}`,
  })

  return {
    path: relativePath,
    deleted: true,
  }
}

export async function renameArtifact(projectId, relativePath, input = {}) {
  await ensureProjectDirs(projectId)
  const fullPath = resolveArtifactFile(projectId, relativePath)
  await assertSafeExistingFile(vaultDir, fullPath)

  const title = String(input.title ?? "").trim()
  if (!title) {
    throw Object.assign(new Error("Title is required"), { statusCode: 400 })
  }

  const parsed = path.parse(fullPath)
  const target = await uniquePath(parsed.dir, `${slugify(title)}${parsed.ext}`)

  if (parsed.ext.toLowerCase() === ".md") {
    const raw = await safeReadTextFile(fullPath)
    const next = raw.startsWith("# ")
      ? raw.replace(/^# .*(\r?\n)/, `# ${title}$1`)
      : `# ${title}\n\n${raw}`
    await safeWriteTextFile(fullPath, next)
  }

  await assertSafeWritableFile(vaultDir, target)
  await fs.rename(fullPath, target)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.renamed",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: projectRelative(projectId, target),
    summary: `Renamed artifact to ${title}`,
    metadata: { previousPath: projectRelative(projectId, fullPath) },
  })

  return {
    name: path.basename(target),
    path: projectRelative(projectId, target),
  }
}

export async function updateMarkdownArtifact(projectId, relativePath, input = {}) {
  await ensureProjectDirs(projectId)
  const fullPath = resolveArtifactFile(projectId, relativePath)
  const saved = await updateMarkdownProjectFile(projectId, fullPath, input, "artifacts")
  await ensureArtifactIndex(projectId)
  await appendSystemLogEvent({
    action: "artifact.updated",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: saved.path,
    summary: `Updated artifact ${path.basename(saved.path)}`,
  })
  return saved
}

export async function updateExcalidrawArtifact(projectId, relativePath, input = {}) {
  await ensureProjectDirs(projectId)
  const fullPath = resolveArtifactFile(projectId, relativePath)
  await assertSafeExistingFile(vaultDir, fullPath)

  if (!isExcalidrawName(fullPath)) {
    throw Object.assign(new Error("Only Excalidraw artifacts can be edited"), { statusCode: 400 })
  }

  if (typeof input.content !== "string") {
    throw Object.assign(new Error("Content is required"), { statusCode: 400 })
  }

  const content = normalizeExcalidrawContent(input.content, input.title)
  await safeWriteTextFile(fullPath, content)
  await ensureArtifactIndex(projectId)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.updated",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: projectRelative(projectId, fullPath),
    summary: `Updated Excalidraw artifact ${path.basename(fullPath)}`,
  })

  return {
    path: projectRelative(projectId, fullPath),
    size: Buffer.byteLength(content, "utf8"),
    content,
  }
}

export async function updateGeneratedMarkdown(projectId, relativePath, input = {}) {
  await ensureProjectDirs(projectId)
  const fullPath = resolveGeneratedFile(projectId, relativePath)
  const saved = await updateMarkdownProjectFile(projectId, fullPath, input, "generated files")
  await appendSystemLogEvent({
    action: "generated.updated",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: saved.path,
    summary: `Updated generated file ${path.basename(saved.path)}`,
  })
  return saved
}

async function updateMarkdownProjectFile(projectId, fullPath, input = {}, label = "files") {
  await assertSafeExistingFile(vaultDir, fullPath)

  if (path.extname(fullPath).toLowerCase() !== ".md") {
    throw Object.assign(new Error(`Only markdown ${label} can be edited`), { statusCode: 400 })
  }

  if (typeof input.content !== "string") {
    throw Object.assign(new Error("Content is required"), { statusCode: 400 })
  }

  const existingRaw = await safeReadTextFile(fullPath)
  const existing = parseFrontmatter(existingRaw)
  const incoming = parseFrontmatter(input.content)
  const lastEdited = nowIso()
  const lastEditor =
    String(input.author ?? input.editor ?? incoming.fields.lastEditor ?? existing.fields.lastEditor ?? existing.fields.creator ?? "team").trim() ||
    "team"
  const content = markdownWithFrontmatter(incoming.body, {
    ...existing.fields,
    ...incoming.fields,
    lastEdited,
    lastEditor,
  })

  await safeWriteTextFile(fullPath, content)
  await touchProject(projectId)
  await appendMentionEventsForWrite(projectId, projectRelative(projectId, fullPath), existingRaw, content, input)

  return {
    path: projectRelative(projectId, fullPath),
    size: Buffer.byteLength(content, "utf8"),
    content,
  }
}

function titleFromPlanContent(parsed, fallback) {
  return String(parsed.fields.title ?? "").trim()
    || titleFromMarkdown(parsed.body)
    || fallback
}

export async function updatePlanItem(projectId, relativePath, input = {}) {
  await ensureProjectDirs(projectId)
  await ensurePlanIndex(projectId)
  const fullPath = resolvePlanItemFile(projectId, relativePath)
  await assertSafeExistingFile(vaultDir, fullPath)

  if (path.extname(fullPath).toLowerCase() !== ".md") {
    throw Object.assign(new Error("Only markdown plan items can be edited"), { statusCode: 400 })
  }

  const existing = parseFrontmatter(await safeReadTextFile(fullPath))
  const hasFullContent = typeof input.content === "string"
  const incoming = hasFullContent
    ? parseFrontmatter(input.content)
    : {
        fields: {
          title: input.title,
          owner: input.owner,
          deadline: input.deadline,
        },
        body: input.body ?? input.content ?? existing.body,
      }
  const existingFields = sanitizePlanItemFields(existing.fields)
  const title = hasFullContent
    ? titleFromMarkdown(incoming.body) || String(incoming.fields.title ?? "").trim() || existingFields.title || path.parse(fullPath).name
    : titleFromPlanContent(incoming, existingFields.title || path.parse(fullPath).name)
  const body = planItemBodyWithoutTitle(incoming.body)
  const nextFields = sanitizePlanItemFields({
    ...existingFields,
    ...incoming.fields,
    title,
    owner: incoming.fields.owner === undefined ? existingFields.owner : incoming.fields.owner,
    deadline: incoming.fields.deadline === undefined ? existingFields.deadline : incoming.fields.deadline,
  })

  const content = planItemContent(title, body, nextFields)

  await safeWriteTextFile(fullPath, content)
  await ensurePlanIndex(projectId)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "plan_item.updated",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: projectRelative(projectId, fullPath),
    summary: `Updated plan item ${title}`,
  })
  await appendMentionEventsForWrite(projectId, projectRelative(projectId, fullPath), existingRaw, content, input, "plan")

  return {
    path: projectRelative(projectId, fullPath),
    size: Buffer.byteLength(content, "utf8"),
    content,
  }
}

export async function togglePlanItem(projectId, relativePath, done) {
  await ensureProjectDirs(projectId)
  await ensurePlanIndex(projectId)

  const normalizedPath = normalizePlanIndexPath(relativePath)
  if (!normalizedPath) {
    throw Object.assign(new Error("Plan item path is required"), { statusCode: 400 })
  }

  const raw = await safeReadTextFile(planIndexPath(projectId))
  const fileName = path.basename(normalizedPath)
  const matcher = /^(-[ \t]+\[)([ xX])(\][ \t]+\[[^\]\r\n]*\]\(([^)\r\n]+)\)(?:[ \t]+(?:—|-)[ \t]*[^\r\n]*)?[ \t]*)$/gm
  let changed = false
  const content = raw.replace(matcher, (line, prefix, current, suffix, href) => {
    const itemPath = normalizePlanIndexPath(href)
    if (itemPath !== normalizedPath) {
      return line
    }

    changed = true
    const nextDone = done === undefined ? current.toLowerCase() !== "x" : Boolean(done)
    return `${prefix}${nextDone ? "x" : " "}${suffix}`
  })

  if (!changed) {
    throw Object.assign(new Error(`Plan item not found: ${fileName}`), { statusCode: 404 })
  }

  await safeWriteTextFile(planIndexPath(projectId), content)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "plan_item.toggled",
    source: "storage",
    actor: "team",
    projectId,
    target: normalizedPath,
    summary: `Toggled plan item ${fileName}`,
  })

  return {
    path: `plan/${PLAN_README_FILE}`,
    itemPath: normalizedPath,
    done: parsePlanIndexItems(content).find((item) => item.path === normalizedPath)?.done ?? Boolean(done),
    content,
  }
}

export async function readProjectFile(projectId, relativePath) {
  if (isArtifactIndexPath(relativePath)) {
    await ensureArtifactIndex(projectId)
  }

  if (isPlanIndexPath(relativePath)) {
    await ensurePlanIndex(projectId)
  }

  const fullPath = resolveProjectFile(projectId, relativePath)
  await assertSafeExistingFile(vaultDir, fullPath)

  return {
    path: projectRelative(projectId, fullPath),
    content: await safeReadTextFile(fullPath),
  }
}

export async function createProjectFileStream(projectId, relativePath) {
  return safeReadStream(resolveProjectFile(projectId, relativePath))
}

export async function readProjectFileBuffer(projectId, relativePath) {
  const fullPath = resolveProjectFile(projectId, relativePath)
  const stat = await assertSafeExistingFile(vaultDir, fullPath)

  return {
    name: path.basename(fullPath),
    path: projectRelative(projectId, fullPath),
    buffer: await safeReadBuffer(fullPath),
    size: stat.size,
  }
}

export async function listPlanItems(projectId) {
  await ensurePlanIndex(projectId)
  const [files, items] = await Promise.all([
    listProjectFiles(projectId, "plan"),
    readPlanIndexItems(projectId),
  ])
  const itemByPath = new Map(items.map((item) => [item.path, item]))

  return files.map((file) => {
    const item = itemByPath.get(file.path)
    return {
      ...file,
      title: item?.title || file.title || indexedFileTitle(file),
      owner: item?.owner || file.owner || "",
      deadline: item?.deadline || file.deadline || "",
      done: Boolean(item?.done),
    }
  })
}

export async function readPlanItem(projectId, relativePath) {
  await ensurePlanIndex(projectId)
  const fullPath = resolvePlanItemFile(projectId, relativePath)
  await assertSafeExistingFile(vaultDir, fullPath)

  const content = await safeReadTextFile(fullPath)
  const parsed = parseFrontmatter(content)
  const indexItem = (await readPlanIndexItems(projectId))
    .find((item) => item.path === projectRelative(projectId, fullPath))

  return {
    path: projectRelative(projectId, fullPath),
    title: titleFromPlanContent(parsed, path.parse(fullPath).name),
    owner: String(parsed.fields.owner ?? indexItem?.owner ?? "").trim(),
    deadline: String(parsed.fields.deadline ?? indexItem?.deadline ?? "").trim(),
    done: Boolean(indexItem?.done),
    content,
  }
}

export async function readDocFile(docId, relativePath) {
  const fullPath = resolveDocFile(docId, relativePath)
  await assertSafeExistingFile(vaultDir, fullPath)

  return {
    path: docRelative(docId, fullPath),
    content: await safeReadTextFile(fullPath),
  }
}

export async function createDocFileStream(docId, relativePath) {
  return safeReadStream(resolveDocFile(docId, relativePath))
}

export async function searchFiles({ projectId, query }) {
  const projects = projectId ? [await getProject(projectId)] : await listProjects()
  const needle = String(query ?? "").toLowerCase()
  const results = []

  for (const project of projects) {
    const detail = project.files ? project : await getProject(project.id)
    const files = [...detail.files.artifacts, ...detail.files.logs, ...detail.files.generated, ...(detail.files.plan ?? [])]

    for (const file of files) {
      const nameMatches = file.name.toLowerCase().includes(needle)
      let contentMatches = false

      if (!nameMatches && file.name.endsWith(".md")) {
        try {
          const raw = await readProjectFile(project.id, file.path)
          contentMatches = raw.content.toLowerCase().includes(needle)
        } catch {
          contentMatches = false
        }
      }

      if (!needle || nameMatches || contentMatches) {
        results.push({
          projectId: project.id,
          projectName: project.name,
          ...file,
        })
      }
    }
  }

  return results.slice(0, 100)
}
