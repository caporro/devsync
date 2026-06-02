import "./env.js"
import { createReadStream, createWriteStream, existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { appendMentionEvents } from "./mentions.js"
import { appendSystemLogEvent } from "./system-log.js"

const PROJECT_FILE = "project.json"
const PLANNING_FILE = "vault-plan.json"
const LEGACY_GANTT_FILE = "gantt.json"
const RESOURCES_DIR = "resources"
const WORK_DIR = "work"
const LEGACY_RESOURCES_DIR = "artifacts"
const LEGACY_WORK_DIR = "generated"
const PROJECT_DIRS = [RESOURCES_DIR, "logs", WORK_DIR, "tasks", "roles", "automations"]
const LEGACY_ACTIVITY_LOG_FILE = "activity.md"
const ACTIVITY_LOG_DIR = "activity"
const TASKS_README_FILE = "README.md"
const LEGACY_TASKS_README_FILE = "readme.md"
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectId)) {
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

function taskIndexPath(projectId) {
  return path.join(projectPath(projectId), "tasks", TASKS_README_FILE)
}

function legacyTaskDirPath(projectId) {
  return path.join(projectPath(projectId), "plan")
}

function isTaskIndexName(fileName) {
  return String(fileName).toLowerCase() === TASKS_README_FILE.toLowerCase()
}

function isTaskIndexPath(relativePath) {
  return String(relativePath).split(path.sep).join("/").toLowerCase() === `tasks/${TASKS_README_FILE.toLowerCase()}`
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

function cleanFolderPath(input) {
  const raw = String(input ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")

  if (!raw) {
    return ""
  }

  const parts = raw.split("/").filter(Boolean)
  if (
    parts.length > 8 ||
    parts.some((part) => part === "." || part === ".." || part.startsWith("."))
  ) {
    throw storagePathError("Invalid folder path")
  }

  return parts.map(cleanFileName).filter(Boolean).join("/")
}

function projectSubdirPath(projectId, dirName, folder = "") {
  const root = path.join(projectPath(projectId), canonicalProjectDirName(dirName))
  const cleanFolder = cleanFolderPath(folder)
  const target = cleanFolder ? path.resolve(root, cleanFolder) : root
  const relative = path.relative(root, target)

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw storagePathError("Invalid folder path")
  }

  return target
}

function normalizeMovableProjectPath(value) {
  const raw = String(value ?? "").trim()
  const normalizedInput = raw.split("\\").join("/")
  if (path.isAbsolute(normalizedInput)) {
    throw storagePathError("Invalid file path")
  }

  const normalized = path.posix.normalize(canonicalProjectRelativePath(normalizedInput).replace(/^\/+/, ""))
  const parts = normalized.split("/").filter(Boolean)
  const root = parts[0]

  if (
    parts.length < 2 ||
    normalized === "." ||
    normalized.startsWith("../") ||
    parts.some((part) => part === "." || part === "..")
  ) {
    throw storagePathError("Invalid file path")
  }

  if (root !== RESOURCES_DIR && root !== WORK_DIR) {
    throw storagePathError("Only resources and work paths can be moved")
  }

  return normalized
}

async function ensureProjectSubdir(projectId, dirName, folder = "") {
  const target = projectSubdirPath(projectId, dirName, folder)
  await ensureSafeDir(target)
  return target
}

function canonicalProjectRelativePath(relativePath) {
  const normalized = String(relativePath ?? "").split("\\").join("/").replace(/^\/+/, "")

  if (normalized.startsWith(`${LEGACY_RESOURCES_DIR}/`)) {
    return `${RESOURCES_DIR}/${normalized.slice(LEGACY_RESOURCES_DIR.length + 1)}`
  }

  if (normalized.startsWith(`${LEGACY_WORK_DIR}/`)) {
    return `${WORK_DIR}/${normalized.slice(LEGACY_WORK_DIR.length + 1)}`
  }

  return normalized
}

async function safeLegacyDir(projectId, dirName) {
  const dir = path.join(projectPath(projectId), dirName)

  try {
    const stat = await fs.lstat(dir)

    if (stat.isSymbolicLink()) {
      throw storagePathError()
    }

    if (!stat.isDirectory()) {
      throw Object.assign(new Error("Not a directory"), { statusCode: 400 })
    }

    await assertRealPathInside(vaultDir, dir)
    return dir
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

async function migrateLegacyProjectDir(projectId, legacyName, canonicalName) {
  const legacyDir = await safeLegacyDir(projectId, legacyName)
  if (!legacyDir) return

  const canonicalDir = path.join(projectPath(projectId), canonicalName)
  try {
    await fs.lstat(canonicalDir)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    await fs.rename(legacyDir, canonicalDir)
  }
}

export async function ensureProjectDirs(projectId) {
  const root = projectPath(projectId)
  await ensureSafeDir(root)
  await migrateLegacyProjectDir(projectId, LEGACY_RESOURCES_DIR, RESOURCES_DIR)
  await migrateLegacyProjectDir(projectId, LEGACY_WORK_DIR, WORK_DIR)
  await migrateLegacyTaskDir(projectId)
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
  const originalRelativePath = String(relativePath ?? "").split("\\").join("/")

  if (path.isAbsolute(originalRelativePath)) {
    throw Object.assign(new Error("Invalid file path"), { statusCode: 400 })
  }

  const normalizedRelativePath = canonicalProjectRelativePath(relativePath)
  const fullPath = path.resolve(root, normalizedRelativePath)
  const relative = path.relative(root, fullPath)

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Invalid file path"), { statusCode: 400 })
  }

  const legacyDirName = legacyProjectDirName(normalizedRelativePath.split("/", 1)[0])
  if (legacyDirName && !existsSync(fullPath)) {
    const parts = normalizedRelativePath.split("/")
    const legacyPath = path.resolve(root, legacyDirName, ...parts.slice(1))
    const legacyRelative = path.relative(root, legacyPath)

    if (!legacyRelative.startsWith("..") && !path.isAbsolute(legacyRelative) && existsSync(legacyPath)) {
      return legacyPath
    }
  }

  return fullPath
}

function canonicalProjectDirName(dirName) {
  if (dirName === LEGACY_RESOURCES_DIR) return RESOURCES_DIR
  if (dirName === LEGACY_WORK_DIR) return WORK_DIR
  return dirName
}

function legacyProjectDirName(dirName) {
  if (dirName === RESOURCES_DIR) return LEGACY_RESOURCES_DIR
  if (dirName === WORK_DIR) return LEGACY_WORK_DIR
  return null
}

function projectDirCandidates(projectId, dirName) {
  const canonicalDirName = canonicalProjectDirName(dirName)
  const candidates = [
    {
      fullPath: path.join(projectPath(projectId), canonicalDirName),
      publicDirName: canonicalDirName,
    },
  ]
  const legacyDirName = legacyProjectDirName(canonicalDirName)

  if (legacyDirName) {
    candidates.push({
      fullPath: path.join(projectPath(projectId), legacyDirName),
      publicDirName: canonicalDirName,
    })
  }

  return candidates
}

function resolveProjectSubdirFile(projectId, relativePath, subdirName, invalidMessage, isIndexPath) {
  const raw = String(relativePath)
  let decodedPath

  try {
    decodedPath = decodeURIComponent(raw)
  } catch {
    throw Object.assign(new Error("Invalid file path encoding"), { statusCode: 400 })
  }

  const originalInput = decodedPath.split("\\").join("/")
  const normalizedInput = canonicalProjectRelativePath(originalInput)
  const prefixedPath = normalizedInput.includes("/") ? normalizedInput : `${subdirName}/${normalizedInput}`
  const normalizedPath = path.posix.normalize(prefixedPath)

  if (
    normalizedPath === `${subdirName}` ||
    normalizedPath === "" ||
    !normalizedPath.startsWith(`${subdirName}/`) ||
    isIndexPath?.(normalizedPath)
  ) {
    throw Object.assign(new Error(invalidMessage), { statusCode: 400 })
  }

  if (path.isAbsolute(originalInput)) {
    throw Object.assign(new Error(invalidMessage), { statusCode: 400 })
  }

  const fullPath = resolveProjectFile(projectId, normalizedPath)
  const allowedRoots = projectDirCandidates(projectId, subdirName).map((candidate) => candidate.fullPath)
  const isAllowedSubdirFile = allowedRoots.some((root) => {
    const relative = path.relative(root, fullPath)
    return relative !== "" && relative !== "." && !relative.startsWith("..") && !path.isAbsolute(relative)
  })

  if (!isAllowedSubdirFile) {
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
  const files = []
  const usedPaths = new Set()
  const canonicalDirName = canonicalProjectDirName(dirName)
  const recursive = canonicalDirName === RESOURCES_DIR || canonicalDirName === WORK_DIR

  for (const candidate of projectDirCandidates(projectId, dirName)) {
    async function visit(dir, parts = []) {
      let entries

      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (error.code === "ENOENT") {
          return
        }

        throw error
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)

        if (entry.isSymbolicLink()) {
          throw storagePathError()
        }

        if (entry.isDirectory()) {
          if (recursive) {
            await visit(fullPath, [...parts, entry.name])
          }
          continue
        }

        if (!entry.isFile()) continue
        if (dirName === "tasks" && isTaskIndexName(entry.name)) continue

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

        const folder = parts.join("/")
        const publicPath = [candidate.publicDirName, ...parts, entry.name].join("/")
        if (usedPaths.has(publicPath)) {
          continue
        }

        usedPaths.add(publicPath)
        files.push({
          name: entry.name,
          path: publicPath,
          folder,
          kind: canonicalDirName,
          size: stat.size,
          title,
          owner,
          deadline,
          createdAt,
          updatedAt: stat.mtime.toISOString(),
        })
      }
    }

    await visit(candidate.fullPath)
  }

  return files.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

async function listProjectFolders(projectId, dirName) {
  const folders = []
  const usedPaths = new Set()
  const canonicalDirName = canonicalProjectDirName(dirName)

  if (canonicalDirName !== RESOURCES_DIR && canonicalDirName !== WORK_DIR) {
    return []
  }

  for (const candidate of projectDirCandidates(projectId, canonicalDirName)) {
    async function visit(dir, parts = []) {
      let entries

      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (error.code === "ENOENT") {
          return
        }

        throw error
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          if (entry.isSymbolicLink()) throw storagePathError()
          continue
        }

        const fullPath = path.join(dir, entry.name)
        const nextParts = [...parts, entry.name]
        const folder = parts.join("/")
        const publicPath = [candidate.publicDirName, ...nextParts].join("/")

        if (!usedPaths.has(publicPath)) {
          const stat = await fs.stat(fullPath)
          usedPaths.add(publicPath)
          folders.push({
            name: entry.name,
            path: publicPath,
            folder,
            kind: candidate.publicDirName,
            updatedAt: stat.mtime.toISOString(),
          })
        }

        await visit(fullPath, nextParts)
      }
    }

    await visit(candidate.fullPath)
  }

  return folders.sort((left, right) => left.path.localeCompare(right.path))
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

function normalizeTaskIndexPath(value) {
  return normalizeIndexPath(value, "tasks", TASKS_README_FILE.toLowerCase())
}

function parseTaskIndexItems(raw) {
  return parseIndexItems(raw, "tasks", TASKS_README_FILE.toLowerCase())
}

function markdownLinkLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("]", "\\]").replace(/\s+/g, " ").trim()
}

function buildTaskIndexContent(files, preferredItems = []) {
  return buildIndexContent({
    title: "Tasks",
    files,
    preferredItems,
    dirName: "tasks",
    readmeName: TASKS_README_FILE.toLowerCase(),
    checkboxes: true,
    owners: true,
    deadlines: true,
    preserveItemTitle: false,
    preserveItemOwner: false,
    preserveItemDeadline: false,
  })
}

async function readTaskIndexItems(projectId) {
  try {
    return parseTaskIndexItems(await safeReadTextFile(taskIndexPath(projectId)))
  } catch (error) {
    if (error.code === "ENOENT") {
      return []
    }

    throw error
  }
}

// TODO: Remove this one-release plan/ -> tasks migration after existing vaults are migrated.
async function migrateLegacyTaskDir(projectId) {
  const root = projectPath(projectId)
  const legacyDir = legacyTaskDirPath(projectId)
  const tasksDir = path.join(root, "tasks")
  let hasLegacy = false
  let hasTasksContent = false

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
    const stat = await fs.lstat(tasksDir)

    if (stat.isSymbolicLink()) {
      throw storagePathError()
    }

    const taskEntries = stat.isDirectory() ? await fs.readdir(tasksDir) : []
    hasTasksContent = taskEntries.some((name) => name !== ".DS_Store")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }

  if (!hasLegacy || hasTasksContent) {
    return
  }

  await fs.rm(tasksDir, { recursive: true, force: true })

  try {
    await fs.rename(legacyDir, tasksDir)
  } catch (error) {
    if (!["EXDEV", "ENOTEMPTY", "EEXIST"].includes(error.code)) {
      throw error
    }
    await fs.cp(legacyDir, tasksDir, { recursive: true, force: false, errorOnExist: false })
    await fs.rm(legacyDir, { recursive: true, force: true })
  }

  const legacyReadme = path.join(tasksDir, LEGACY_TASKS_README_FILE)
  const taskReadme = path.join(tasksDir, TASKS_README_FILE)

  try {
    const raw = await safeReadTextFile(legacyReadme)
    const next = raw
      .replace(/^#\s+Plan\s*$/im, "# Tasks")
      .replace(/\]\((?:plan\/)?([^)]+)\)/g, "]($1)")

    await safeWriteTextFile(taskReadme, next)
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }
}

export async function ensureTaskIndex(projectId) {
  await ensureProjectDirs(projectId)

  const files = await listProjectFiles(projectId, "tasks")
  const content = buildTaskIndexContent(files, await readTaskIndexItems(projectId))
  const target = taskIndexPath(projectId)

  try {
    if ((await safeReadTextFile(target)) === content) {
      return {
        path: `tasks/${TASKS_README_FILE}`,
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
    path: `tasks/${TASKS_README_FILE}`,
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
  const match = String(content).match(/\]\((?:\.\.\/)?((?:resources|artifacts)\/[^)#]+)(?:#[^)]+)?\)/)
  return match ? canonicalProjectRelativePath(match[1]) : null
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

  const entries = await fs.readdir(dataDir, { withFileTypes: true })
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try {
      assertProjectId(entry.name)
    } catch {
      return
    }

    await migrateLegacyTaskDir(entry.name)
  }))
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
      await ensureTaskIndex(entry.name)
      const [resources, work, tasks, activity] = await Promise.all([
        listProjectFiles(entry.name, RESOURCES_DIR),
        listProjectFiles(entry.name, WORK_DIR),
        listProjectFiles(entry.name, "tasks"),
        getActivityLog(entry.name),
      ])

      projects.push({
        ...metadata,
        counts: {
          resources: resources.length,
          logs: activity.entries.length,
          work: work.length,
          tasks: tasks.length,
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
  await ensureTaskIndex(projectId)
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
  await ensureTaskIndex(projectId)
  const [metadata, resources, logs, work, tasks, resourceFolders, workFolders, activity] = await Promise.all([
    getProjectMetadata(projectId),
    listProjectFiles(projectId, RESOURCES_DIR),
    listProjectFiles(projectId, "logs"),
    listProjectFiles(projectId, WORK_DIR),
    listProjectFiles(projectId, "tasks"),
    listProjectFolders(projectId, RESOURCES_DIR),
    listProjectFolders(projectId, WORK_DIR),
    getActivityLog(projectId, { files: options.activityFiles }),
  ])

  return {
    ...metadata,
    activity,
    files: {
      resources,
      logs,
      work,
      tasks,
    },
    folders: {
      resources: resourceFolders,
      work: workFolders,
    },
    counts: {
      resources: resources.length,
      logs: activity.entries.length,
      work: work.length,
      tasks: tasks.length,
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

  const dir = await ensureProjectSubdir(projectId, RESOURCES_DIR, input?.folder)
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
    content: `Added resource [${markdownLinkLabel(title)}](../${relativePath}).`,
  })
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.created",
    source: input?.source ?? "storage",
    actor: creator,
    projectId,
    target: relativePath,
    summary: `Added text resource ${title}`,
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
  const dir = await ensureProjectSubdir(projectId, RESOURCES_DIR, input?.folder)
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
    content: `Added resource [${markdownLinkLabel(title)}](../${relativePath}).`,
  })
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.created",
    source: input?.source ?? "storage",
    actor: creator,
    projectId,
    target: relativePath,
    summary: `Added link resource ${title}`,
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
  const dir = await ensureProjectSubdir(projectId, RESOURCES_DIR, input?.folder)
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
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.created",
    source: input?.source ?? "storage",
    actor: creator,
    projectId,
    target: relativePath,
    summary: `Added Excalidraw resource ${title}`,
  })

  return {
    name: path.basename(target),
    path: relativePath,
  }
}

function normalizeTaskDeadline(value) {
  const deadline = String(value ?? "").trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : ""
}

function sanitizeTaskFields(fields = {}) {
  return {
    title: String(fields.title ?? "").trim(),
    createdAt: String(fields.createdAt ?? "").trim(),
    createdBy: String(fields.createdBy ?? "").trim(),
    owner: String(fields.owner ?? "").trim(),
    deadline: normalizeTaskDeadline(fields.deadline),
  }
}

function taskContent(title, body, fields) {
  return markdownWithFrontmatter(`# ${title}\n\n${String(body ?? "").trim()}`, sanitizeTaskFields(fields))
}

function taskBodyWithoutTitle(body) {
  return String(body ?? "").trimStart().replace(/^#\s+.*(?:\r?\n|$)/, "").trim()
}

function normalizeTaskBody(body, title) {
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

async function appendTaskAssignedEvent({
  actor,
  projectId,
  source,
  target,
  title,
  previousOwner,
  nextOwner,
}) {
  if (String(previousOwner ?? "") === String(nextOwner ?? "")) {
    return
  }

  await appendSystemLogEvent({
    action: "task.assigned",
    source: source ?? "storage",
    actor: String(actor ?? "team").trim() || "team",
    projectId,
    target,
    summary: `Assigned task ${title || "task"}`,
    metadata: {
      previousOwner: previousOwner || null,
      owner: nextOwner || null,
    },
  })
}

export async function createTask(projectId, input) {
  await ensureProjectDirs(projectId)
  await ensureTaskIndex(projectId)

  const title = String(input?.title ?? "").trim()
  const content = String(input?.content ?? input?.body ?? "").trim()
  const created = nowIso()
  const creator = String(input?.createdBy ?? input?.author ?? input?.creator ?? "team").trim() || "team"
  const owner = String(input?.owner ?? "").trim()
  const deadline = normalizeTaskDeadline(input?.deadline)

  if (!title) {
    throw Object.assign(new Error("Task title is required"), { statusCode: 400 })
  }

  const dir = path.join(projectPath(projectId), "tasks")
  const target = await uniquePathWithNumberSuffix(dir, `${dateStamp(new Date(created))}-${slugify(title)}.md`)
  const document = taskContent(title, normalizeTaskBody(content, title), {
    title,
    createdAt: created,
    createdBy: creator,
    owner,
    deadline,
  })
  await safeWriteTextFile(target, document)
  const relativePath = projectRelative(projectId, target)
  await ensureTaskIndex(projectId)
  await appendActivityEntry(projectId, {
    createdAt: created,
    author: creator,
    title: `Created task ${title}`,
    content: `Created task: ${title} (${relativePath}).`,
  })
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "task.created",
    source: input?.source ?? "storage",
    actor: creator,
    projectId,
    target: relativePath,
    summary: `Created task ${title}`,
  })
  await appendMentionEventsForWrite(projectId, relativePath, "", document, input, "task")

  return {
    name: path.basename(target),
    path: relativePath,
  }
}

async function updateTaskFieldsFromIndex(projectId, item) {
  const title = String(item?.title ?? "").trim()
  const owner = String(item?.owner ?? "").trim()
  const deadline = normalizeTaskDeadline(item?.deadline)

  const fullPath = resolveTaskFile(projectId, item.path)
  const before = await safeReadTextFile(fullPath)
  const existing = parseFrontmatter(before)
  const existingFields = sanitizeTaskFields(existing.fields)
  const currentTitle = titleFromTaskContent(existing, path.parse(fullPath).name)
  const nextTitle = title || currentTitle

  if (currentTitle === nextTitle && existingFields.owner === owner && existingFields.deadline === deadline) {
    return null
  }

  const body = taskBodyWithoutTitle(existing.body)
  const content = taskContent(nextTitle, body, {
    ...existingFields,
    title: nextTitle,
    owner,
    deadline,
  })

  if (content === before) {
    return null
  }

  await safeWriteTextFile(fullPath, content)
  return {
    before,
    after: content,
    path: projectRelative(projectId, fullPath),
    title: nextTitle,
    previousOwner: existingFields.owner,
    nextOwner: owner,
  }
}

export async function updateTaskIndex(projectId, input = {}) {
  await ensureProjectDirs(projectId)
  await ensureTaskIndex(projectId)

  const requestedItems = Array.isArray(input.items)
    ? input.items.map((item) => ({
        path: normalizeTaskIndexPath(item?.path),
        title: String(item?.title ?? "").trim(),
        done: Boolean(item?.done),
        owner: String(item?.owner ?? "").trim(),
        deadline: normalizeTaskDeadline(item?.deadline),
      }))
    : typeof input.content === "string"
      ? parseTaskIndexItems(input.content)
      : await readTaskIndexItems(projectId)

  const taskUpdateDetails = (
    await Promise.all(requestedItems.filter((item) => item.path).map((item) => updateTaskFieldsFromIndex(projectId, item)))
  ).filter((detail) => detail && detail.path)

  await Promise.all(taskUpdateDetails.map((detail) =>
    appendMentionEventsForWrite(projectId, detail.path, detail.before, detail.after, input, "task")
  ))
  await Promise.all(
    taskUpdateDetails
      .filter((detail) => detail.previousOwner !== detail.nextOwner)
      .map((detail) => appendTaskAssignedEvent({
        actor: input?.author ?? input?.editor ?? "team",
        projectId,
        source: input?.source ?? "storage",
        target: detail.path,
        title: detail.title,
        previousOwner: detail.previousOwner,
        nextOwner: detail.nextOwner,
      }))
  )

  const files = await listProjectFiles(projectId, "tasks")
  const content = buildTaskIndexContent(files, requestedItems)
  const target = taskIndexPath(projectId)
  const existingRaw = await safeReadTextFile(target).catch((error) => {
    if (error.code === "ENOENT") return ""
    throw error
  })

  await safeWriteTextFile(target, content)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "task_index.updated",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: `tasks/${TASKS_README_FILE}`,
    summary: "Updated task index",
  })
  await appendMentionEventsForWrite(projectId, `tasks/${TASKS_README_FILE}`, existingRaw, content, input, "task")

  return {
    path: `tasks/${TASKS_README_FILE}`,
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
    const dir = await ensureProjectSubdir(projectId, RESOURCES_DIR)
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

  const dir = await ensureProjectSubdir(projectId, RESOURCES_DIR, input?.folder)
  const target = await uniquePath(dir, cleanFileName(filePart.filename))
  await safeUploadStream(target, filePart.file)
  const relativePath = projectRelative(projectId, target)
  if (input.logActivity !== false) {
    await appendActivityEntry(projectId, {
      author: input.author ?? "team",
      kind: "artifact",
      artifactPath: relativePath,
      title: `Uploaded ${path.basename(target)}`,
      content: `Uploaded resource [${path.basename(target)}](../${relativePath}).`,
    })
  }
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.uploaded",
    source: input?.source ?? "storage",
    actor: input.author ?? "team",
    projectId,
    target: relativePath,
    summary: `Uploaded resource ${path.basename(target)}`,
  })

  return {
    name: path.basename(target),
    path: relativePath,
  }
}

export async function createProjectFolder(projectId, dirName, input = {}) {
  await ensureProjectDirs(projectId)
  const canonicalDirName = canonicalProjectDirName(dirName)

  if (canonicalDirName !== RESOURCES_DIR && canonicalDirName !== WORK_DIR) {
    throw Object.assign(new Error("Only resources and work folders can be created"), { statusCode: 400 })
  }

  const folder = cleanFolderPath(input?.folder ?? input?.path)
  if (!folder) {
    throw Object.assign(new Error("Folder path is required"), { statusCode: 400 })
  }

  const target = await ensureProjectSubdir(projectId, canonicalDirName, folder)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "folder.created",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.creator ?? "team",
    projectId,
    target: `${canonicalDirName}/${folder}`,
    summary: `Created ${canonicalDirName} folder ${folder}`,
  })

  return {
    path: `${canonicalDirName}/${folder}`,
    name: path.basename(target),
  }
}

export async function moveProjectEntry(projectId, input = {}) {
  await ensureProjectDirs(projectId)

  const from = normalizeMovableProjectPath(input?.from)
  const to = normalizeMovableProjectPath(input?.to)
  const fromRoot = from.split("/", 1)[0]
  const toRoot = to.split("/", 1)[0]

  if (fromRoot !== toRoot) {
    throw Object.assign(new Error("Files and folders can only move within the same area"), { statusCode: 400 })
  }

  const projectRoot = projectPath(projectId)
  const source = resolveProjectFile(projectId, from)

  let sourceStat
  try {
    sourceStat = await fs.lstat(source)
  } catch (error) {
    if (error.code === "ENOENT") {
      throw Object.assign(new Error("Source file or folder not found"), { statusCode: 404 })
    }

    throw error
  }

  if (sourceStat.isSymbolicLink()) {
    throw storagePathError()
  }

  await assertRealPathInside(vaultDir, source)

  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    throw Object.assign(new Error("Only files and folders can be moved"), { statusCode: 400 })
  }

  const kind = sourceStat.isDirectory() ? "folder" : "file"
  if (from === to) {
    return { from, to, moved: false, kind }
  }

  const target = path.resolve(projectRoot, to)
  const targetRelative = path.relative(projectRoot, target)
  if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) {
    throw storagePathError()
  }

  const bucketRoot = projectSubdirPath(projectId, toRoot)
  if (!pathInside(bucketRoot, target)) {
    throw storagePathError()
  }

  if (sourceStat.isDirectory() && pathInside(source, target)) {
    throw Object.assign(new Error("Cannot move a folder into itself"), { statusCode: 400 })
  }

  try {
    await fs.lstat(target)
    throw Object.assign(new Error("Target already exists"), { statusCode: 409 })
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }

  const targetParent = path.dirname(target)
  if (!pathInside(bucketRoot, targetParent)) {
    throw storagePathError()
  }

  let parentStat
  try {
    parentStat = await fs.lstat(targetParent)
  } catch (error) {
    if (error.code === "ENOENT") {
      throw Object.assign(new Error("Target folder does not exist"), { statusCode: 400 })
    }

    throw error
  }

  if (parentStat.isSymbolicLink()) {
    throw storagePathError()
  }

  if (!parentStat.isDirectory()) {
    throw Object.assign(new Error("Target parent is not a folder"), { statusCode: 400 })
  }

  await assertRealPathInside(vaultDir, targetParent)
  await fs.rename(source, target)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "file.moved",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: to,
    summary: `Moved ${kind} to ${to}`,
    metadata: { previousPath: from, kind },
  })

  return { from, to, moved: true, kind }
}

function resolveArtifactFile(projectId, relativePath) {
  return resolveProjectSubdirFile(projectId, relativePath, RESOURCES_DIR, "Only resource files can be changed")
}

function resolveTaskFile(projectId, relativePath) {
  return resolveProjectSubdirFile(projectId, relativePath, "tasks", "Only task files can be changed", isTaskIndexPath)
}

function resolveGeneratedFile(projectId, relativePath) {
  return resolveProjectSubdirFile(projectId, relativePath, WORK_DIR, "Only work files can be changed")
}

export async function deleteArtifact(projectId, relativePath) {
  await ensureProjectDirs(projectId)
  const fullPath = resolveArtifactFile(projectId, relativePath)
  await safeUnlinkFile(fullPath)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.deleted",
    source: "storage",
    actor: "team",
    projectId,
    target: projectRelative(projectId, fullPath),
    summary: `Deleted resource ${path.basename(fullPath)}`,
  })

  return {
    path: relativePath,
    deleted: true,
  }
}

export async function deleteTask(projectId, relativePath) {
  await ensureProjectDirs(projectId)
  await ensureTaskIndex(projectId)
  const fullPath = resolveTaskFile(projectId, relativePath)
  await safeUnlinkFile(fullPath)
  await ensureTaskIndex(projectId)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "task.deleted",
    source: "storage",
    actor: "team",
    projectId,
    target: projectRelative(projectId, fullPath),
    summary: `Deleted task ${path.basename(fullPath)}`,
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
    summary: `Renamed resource to ${title}`,
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
  const saved = await updateMarkdownProjectFile(projectId, fullPath, input, "resources")
  await appendSystemLogEvent({
    action: "artifact.updated",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: saved.path,
    summary: `Updated resource ${path.basename(saved.path)}`,
  })
  return saved
}

export async function updateExcalidrawArtifact(projectId, relativePath, input = {}) {
  await ensureProjectDirs(projectId)
  const fullPath = resolveArtifactFile(projectId, relativePath)
  await assertSafeExistingFile(vaultDir, fullPath)

  if (!isExcalidrawName(fullPath)) {
    throw Object.assign(new Error("Only Excalidraw resources can be edited"), { statusCode: 400 })
  }

  if (typeof input.content !== "string") {
    throw Object.assign(new Error("Content is required"), { statusCode: 400 })
  }

  const content = normalizeExcalidrawContent(input.content, input.title)
  await safeWriteTextFile(fullPath, content)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.updated",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: projectRelative(projectId, fullPath),
    summary: `Updated Excalidraw resource ${path.basename(fullPath)}`,
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
  const saved = await updateMarkdownProjectFile(projectId, fullPath, input, "work files")
  await appendSystemLogEvent({
    action: "work.updated",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: saved.path,
    summary: `Updated work file ${path.basename(saved.path)}`,
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

function titleFromTaskContent(parsed, fallback) {
  return String(parsed.fields.title ?? "").trim()
    || titleFromMarkdown(parsed.body)
    || fallback
}

export async function updateTask(projectId, relativePath, input = {}) {
  await ensureProjectDirs(projectId)
  await ensureTaskIndex(projectId)
  const fullPath = resolveTaskFile(projectId, relativePath)
  await assertSafeExistingFile(vaultDir, fullPath)

  if (path.extname(fullPath).toLowerCase() !== ".md") {
    throw Object.assign(new Error("Only markdown tasks can be edited"), { statusCode: 400 })
  }

  const existingRaw = await safeReadTextFile(fullPath)
  const existing = parseFrontmatter(existingRaw)
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
  const existingFields = sanitizeTaskFields(existing.fields)
  const title = hasFullContent
    ? titleFromMarkdown(incoming.body) || String(incoming.fields.title ?? "").trim() || existingFields.title || path.parse(fullPath).name
    : titleFromTaskContent(incoming, existingFields.title || path.parse(fullPath).name)
  const body = taskBodyWithoutTitle(incoming.body)
  const nextFields = sanitizeTaskFields({
    ...existingFields,
    ...incoming.fields,
    title,
    owner: incoming.fields.owner === undefined ? existingFields.owner : incoming.fields.owner,
    deadline: incoming.fields.deadline === undefined ? existingFields.deadline : incoming.fields.deadline,
  })

  const content = taskContent(title, body, nextFields)
  const previousOwner = existingFields.owner
  const nextOwner = nextFields.owner

  await safeWriteTextFile(fullPath, content)
  await ensureTaskIndex(projectId)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "task.updated",
    source: input?.source ?? "storage",
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    target: projectRelative(projectId, fullPath),
    summary: `Updated task ${title}`,
  })
  await appendTaskAssignedEvent({
    actor: input?.author ?? input?.editor ?? "team",
    projectId,
    source: input?.source ?? "storage",
    target: projectRelative(projectId, fullPath),
    title,
    previousOwner,
    nextOwner,
  })
  await appendMentionEventsForWrite(projectId, projectRelative(projectId, fullPath), existingRaw, content, input, "task")

  return {
    path: projectRelative(projectId, fullPath),
    size: Buffer.byteLength(content, "utf8"),
    content,
  }
}

export async function toggleTask(projectId, relativePath, done) {
  await ensureProjectDirs(projectId)
  await ensureTaskIndex(projectId)

  const normalizedPath = normalizeTaskIndexPath(relativePath)
  if (!normalizedPath) {
    throw Object.assign(new Error("Task path is required"), { statusCode: 400 })
  }

  const raw = await safeReadTextFile(taskIndexPath(projectId))
  const fileName = path.basename(normalizedPath)
  const matcher = /^(-[ \t]+\[)([ xX])(\][ \t]+\[[^\]\r\n]*\]\(([^)\r\n]+)\)(?:[ \t]+(?:—|-)[ \t]*[^\r\n]*)?[ \t]*)$/gm
  let changed = false
  const content = raw.replace(matcher, (line, prefix, current, suffix, href) => {
    const itemPath = normalizeTaskIndexPath(href)
    if (itemPath !== normalizedPath) {
      return line
    }

    changed = true
    const nextDone = done === undefined ? current.toLowerCase() !== "x" : Boolean(done)
    return `${prefix}${nextDone ? "x" : " "}${suffix}`
  })

  if (!changed) {
    throw Object.assign(new Error(`Task not found: ${fileName}`), { statusCode: 404 })
  }

  await safeWriteTextFile(taskIndexPath(projectId), content)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "task.toggled",
    source: "storage",
    actor: "team",
    projectId,
    target: normalizedPath,
    summary: `Toggled task ${fileName}`,
  })

  return {
    path: `tasks/${TASKS_README_FILE}`,
    itemPath: normalizedPath,
    done: parseTaskIndexItems(content).find((item) => item.path === normalizedPath)?.done ?? Boolean(done),
    content,
  }
}

export async function readProjectFile(projectId, relativePath) {
  const normalizedPath = canonicalProjectRelativePath(relativePath)

  if (isTaskIndexPath(normalizedPath)) {
    await ensureTaskIndex(projectId)
  }

  const fullPath = resolveProjectFile(projectId, normalizedPath)
  await assertSafeExistingFile(vaultDir, fullPath)

  return {
    path: canonicalProjectRelativePath(projectRelative(projectId, fullPath)),
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
    path: canonicalProjectRelativePath(projectRelative(projectId, fullPath)),
    buffer: await safeReadBuffer(fullPath),
    size: stat.size,
  }
}

export async function listTasks(projectId) {
  await ensureTaskIndex(projectId)
  const [files, items] = await Promise.all([
    listProjectFiles(projectId, "tasks"),
    readTaskIndexItems(projectId),
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

export async function readTask(projectId, relativePath) {
  await ensureTaskIndex(projectId)
  const fullPath = resolveTaskFile(projectId, relativePath)
  await assertSafeExistingFile(vaultDir, fullPath)

  const content = await safeReadTextFile(fullPath)
  const parsed = parseFrontmatter(content)
  const indexItem = (await readTaskIndexItems(projectId))
    .find((item) => item.path === projectRelative(projectId, fullPath))

  return {
    path: projectRelative(projectId, fullPath),
    title: titleFromTaskContent(parsed, path.parse(fullPath).name),
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
    const files = [...detail.files.resources, ...detail.files.logs, ...detail.files.work, ...(detail.files.tasks ?? [])]

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
