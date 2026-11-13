import "./env.js"
import { createReadStream, createWriteStream, existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { pipeline } from "node:stream/promises"
import { appendMentionEvents } from "./mentions.js"
import { appendSystemLogEvent } from "./system-log.js"
import { createDocumentIndex, documentRevision, withDocumentFields, withDocumentBody } from "./document-index.js"
import { taskEvents } from "./task-events.js"
import { resolveTaskOwner } from "./auth.js"
import { parseFrontmatter as parseTaskFrontmatter } from "./markdown-definitions.js"
import { assertNoTaskCommentMarkers, preserveTaskComments, splitTaskComments, withTaskComment } from "./task-comments.js"

const PROJECT_FILE = "project.json"
const RESOURCES_DIR = "resources"
const WORK_DIR = "work"
const LEGACY_RESOURCES_DIR = "artifacts"
const LEGACY_WORK_DIR = "generated"
const PROJECT_DIRS = [RESOURCES_DIR, "logs", WORK_DIR, "tasks", "automations"]
const LEGACY_ACTIVITY_LOG_FILE = "activity.md"
const ACTIVITY_LOG_DIR = "activity"
const TASKS_README_FILE = "README.md"
export const TASK_STATUSES = ["backlog", "todo", "doing", "pause", "done", "rejected"]
const TASK_INDEX_MARKER = "<!-- devsync:tasks-v2; generated from task files -->"
const taskQueues = new Map()
const activityQueues = new Map()

function withTaskLock(projectId, operation) {
  assertProjectId(projectId)
  const pending = (taskQueues.get(projectId) ?? Promise.resolve()).then(operation)
  const settled = pending.catch(() => {})
  taskQueues.set(projectId, settled)
  void settled.then(() => { if (taskQueues.get(projectId) === settled) taskQueues.delete(projectId) })
  return pending
}

function withActivityLock(projectId, operation) {
  assertProjectId(projectId)
  const pending = (activityQueues.get(projectId) ?? Promise.resolve()).then(operation)
  const settled = pending.catch(() => {})
  activityQueues.set(projectId, settled)
  void settled.then(() => { if (activityQueues.get(projectId) === settled) activityQueues.delete(projectId) })
  return pending
}
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

const legacyDataDir = process.env.DEVSYNC_DATA_DIR?.trim() || undefined

export const vaultName = resolveVaultName()
export const dataRootDir = path.resolve(process.env.DEVSYNC_DATA_ROOT ?? path.join(process.cwd(), "data"))
export const vaultDir = path.resolve(legacyDataDir ? path.dirname(legacyDataDir) : path.join(dataRootDir, vaultName))
export const dataDir = path.resolve(legacyDataDir ?? path.join(vaultDir, "projects"))
export const docsDir = path.join(vaultDir, "docs")
export const documentIndex = createDocumentIndex({ vaultDir, projectsDir: dataDir, docsDir })

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

function taskTags(value = []) {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw Object.assign(new Error("tags must be an array of strings"), { statusCode: 400 })
  }
  return [...new Set(normalizeList(value))]
}

function cleanFileName(input) {
  const cleaned = path
    .basename(String(input || "file"))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const { name, ext } = path.parse(cleaned)
  // Reserve space for the extension before truncating the basename.
  return ext.length < 140
    ? `${name.slice(0, 140 - ext.length)}${ext}` || "file"
    : cleaned.slice(0, 140) || "file"
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
  if (!pathInside(vaultDir, target)) throw storagePathError()
  // Validate and create each ancestor before descending. Recursive mkdir on a
  // child of an existing symlink can create directories outside the vault.
  if (target !== vaultDir) await ensureSafeDir(path.dirname(target))
  let stat
  try {
    stat = await fs.lstat(target)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    try {
      await fs.mkdir(target, { recursive: target === vaultDir })
    } catch (cause) {
      if (cause.code !== "EEXIST") throw cause
    }
    stat = await fs.lstat(target)
  }
  if (stat.isSymbolicLink()) throw storagePathError()
  if (!stat.isDirectory()) throw Object.assign(new Error("Not a directory"), { statusCode: 400 })
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

async function safeWriteTextFile(target, content, options = {}) {
  await assertSafeWritableFile(vaultDir, target)
  if (documentIndex.recognizes(target)) return documentIndex.write(target, content, options)
  await fs.writeFile(target, content, "utf8")
  return content
}

async function safeAppendTextFile(target, content) {
  await assertSafeWritableFile(vaultDir, target)
  if (documentIndex.recognizes(target)) return documentIndex.write(target, content, { append: true })
  await fs.appendFile(target, content, "utf8")
}

async function safeUnlinkFile(target) {
  await assertSafeExistingFile(vaultDir, target)
  await fs.unlink(target)
  if (documentIndex.recognizes(target)) await documentIndex.reconcile()
}

async function safeReadStream(target) {
  await assertSafeExistingFile(vaultDir, target)
  return createReadStream(target)
}

async function safeUploadStream(target, input) {
  await assertSafeWritableFile(vaultDir, target)
  await pipeline(input, createWriteStream(target, { flags: "wx" }))
  if (documentIndex.recognizes(target)) await documentIndex.reconcile()
}

async function readJson(filePath) {
  const raw = await safeReadTextFile(filePath)
  return JSON.parse(raw)
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
      const suffix = `-${index}`
      candidate = `${parsed.name.slice(0, Math.max(0, 140 - parsed.ext.length - suffix.length))}${suffix}${parsed.ext}`
      index += 1
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      return target
    }
  }
}

async function uniquePathWithNumberSuffix(dir, wantedName, reserved = new Set()) {
  const parsed = path.parse(cleanFileName(wantedName))
  let candidate = `${parsed.name}${parsed.ext}`
  let index = 1

  while (true) {
    const target = path.join(dir, candidate)
    try {
      if (!reserved.has(target)) await fs.access(target)
      const suffix = String(index)
      candidate = `${parsed.name.slice(0, Math.max(0, 140 - parsed.ext.length - suffix.length))}${suffix}${parsed.ext}`
      index += 1
    } catch (error) {
      if (error.code !== "ENOENT") throw error
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
  const root = docPath(docId)
  const files = []
  async function visit(directory) {
    await assertRealPathInside(vaultDir, directory)
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw storagePathError()
      if (entry.isDirectory()) {
        await visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.stat(fullPath)
      let title = null
      let id = null
      if (isMarkdownName(entry.name)) {
        const parsed = parseFrontmatter(await safeReadTextFile(fullPath))
        title = String(parsed.fields.title ?? "").trim() || titleFromMarkdown(parsed.body)
        id = parsed.fields.id
      }
      files.push({
        name: entry.name, path: docRelative(docId, fullPath), kind: "docs", size: stat.size,
        title, ...(id ? { id, url: `/d/${id}` } : {}), updatedAt: stat.mtime.toISOString(),
      })
    }
  }
  await visit(root)
  return files.sort((left, right) => {
    if (left.path === "README.md") return -1
    if (right.path === "README.md") return 1
    return left.path.localeCompare(right.path)
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
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? JSON.stringify(value) : yamlValue(value)}`)
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

    if (item[2].startsWith("[")) {
      try {
        const value = JSON.parse(item[2])
        if (Array.isArray(value)) { fields[item[1]] = value; continue }
      } catch { /* Keep existing scalar handling for legacy metadata. */ }
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
  const matcher = /^-[ \t]+(?:\[([ xX])\][ \t]+)?\[((?:\\.|[^\]\\\r\n])*)\]\(((?:\\.|[^)\\\r\n])+)\)(?:[ \t]+(?:—|-)[ \t]*(.+?))?[ \t]*$/gm
  let match

  while ((match = matcher.exec(String(raw)))) {
    const itemPath = normalizeIndexPath(match[3], dirName, readmeName)
    if (!itemPath) {
      continue
    }

    const suffix = parseIndexSuffix(match[4])
    items.push({
      path: itemPath,
      title: match[2].trim().replace(/\\([\\[\]])/g, "$1"),
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

function parseTaskIndexItems(raw) {
  return parseIndexItems(raw, "tasks", TASKS_README_FILE.toLowerCase())
}

function markdownLinkLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("]", "\\]").replace(/\s+/g, " ").trim()
}

function buildTaskIndexContent(files) {
  const lines = ["# Tasks", "", TASK_INDEX_MARKER, ""]
  for (const file of files) {
    const suffix = [file.owner, file.deadline ? `due ${file.deadline}` : "", `status: ${file.status}`]
      .filter(Boolean)
      .map(markdownLinkLabel)
      .join(" — ")
    lines.push(
      `- [${file.status === "done" ? "x" : " "}] [${markdownLinkLabel(indexedFileTitle(file))}](${encodeURI(file.name)}) — ${suffix}`
    )
  }
  return `${lines.join("\n").trimEnd()}\n`
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
    await fs.access(taskReadme)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    try { await fs.rename(legacyReadme, taskReadme) } catch (cause) { if (cause.code !== "ENOENT") throw cause }
  }
}

function taskStatus(value, fallback = "backlog") {
  const status = value === undefined ? fallback : String(value).trim()
  if (!TASK_STATUSES.includes(status)) {
    throw Object.assign(new Error(`Invalid task status: ${status}. Use ${TASK_STATUSES.join(", ")}`), {
      statusCode: 400
    })
  }
  return status
}

function taskOrder(value) {
  const order = Number(value)
  if (value === undefined || value === "" || !Number.isSafeInteger(order) || order < 0) {
    throw Object.assign(new Error("Task order must be a non-negative integer"), { statusCode: 400 })
  }
  return order
}

function requireTaskRevision(input) {
  if (!/^[0-9a-f]{64}$/.test(input.expectedRevision ?? "")) {
    throw Object.assign(new Error("Read the task first and provide expectedRevision"), { statusCode: 400 })
  }
}

async function readTaskFiles(projectId) {
  const files = (await listProjectFiles(projectId, "tasks")).filter(
    (file) => isMarkdownName(file.name) && !file.name.startsWith(".")
  )
  return Promise.all(
    files.map(async (file) => {
      const content = await safeReadTextFile(resolveTaskFile(projectId, file.path))
      const fields = parseTaskFrontmatter(content).data
      return {
        ...file,
        id: fields.id,
        title: String(fields.title || titleFromMarkdown(parseTaskFrontmatter(content).body) || indexedFileTitle(file)),
        owner: String(fields.owner ?? ""),
        deadline: String(fields.deadline ?? ""),
        createdBy: String(fields.createdBy ?? fields.creator ?? ""),
        updatedBy: String(fields.lastEditor ?? ""),
        tags: normalizeList(fields.tags),
        status: fields.status,
        order: fields.order === undefined ? undefined : taskOrder(fields.order),
        revision: documentRevision(content),
        content
      }
    })
  )
}

function sortTasks(files) {
  return files.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))
}

async function backupLegacyTask(projectId, name, content) {
  const directory = path.join(projectPath(projectId), "tasks", ".migration-v2")
  await ensureSafeDir(directory)
  const target = path.join(directory, name)
  await assertSafeWritableFile(vaultDir, target)
  await fs.writeFile(target, content, { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error
  })
}

async function migrateTaskFile(target, content, expectedRevision) {
  await assertSafeWritableFile(vaultDir, target)
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  const stat = await fs.stat(target)
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: stat.mode })
    if (documentRevision(await safeReadTextFile(target)) !== expectedRevision) {
      throw Object.assign(new Error("Task changed during migration. Retry after reading it again."), {
        statusCode: 409
      })
    }
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function ensureTaskIndexUnlocked(projectId) {
  await ensureProjectDirs(projectId)
  const target = taskIndexPath(projectId)
  let originalIndex = ""
  try {
    originalIndex = await safeReadTextFile(target)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    const lowerCaseIndex = path.join(projectPath(projectId), "tasks", LEGACY_TASKS_README_FILE)
    try {
      originalIndex = await safeReadTextFile(lowerCaseIndex)
      await fs.rename(lowerCaseIndex, target)
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause
    }
  }
  const legacy = !originalIndex.includes(TASK_INDEX_MARKER)
  const indexItems = legacy ? parseTaskIndexItems(originalIndex) : []
  const files = await readTaskFiles(projectId)
  const byPath = new Map(files.map((file) => [file.path, file]))
  const orderedPaths = [
    ...new Set([
      ...indexItems.map((item) => item.path).filter((item) => byPath.has(item)),
      ...files.map((file) => file.path)
    ])
  ]
  let nextOrder = Math.max(-1, ...files.map((file) => file.order ?? -1)) + 1
  const changes = []
  for (const [index, itemPath] of orderedPaths.entries()) {
    const file = byPath.get(itemPath)
    const previous = parseTaskFrontmatter(file.content).data
    const item = indexItems.find((item) => item.path === itemPath)
    const status = legacy && previous.status === "open" ? undefined : previous.status || undefined
    const fields = {
      status: taskStatus(status, item?.done ? "done" : "todo"),
      order: file.order ?? (legacy ? index : nextOrder++),
      owner: resolveTaskOwner(previous.owner || item?.owner || ""),
      deadline: String(previous.deadline || item?.deadline || ""),
      title: String(
        previous.title || titleFromMarkdown(parseTaskFrontmatter(file.content).body) || item?.title || file.title
      )
    }
    const changed = Object.entries(fields).some(([key, value]) => String(previous[key] ?? "") !== String(value))
    if (changed) changes.push({ file, content: withDocumentFields(file.content, fields) })
  }
  // Back up originals before the first migration write. A retry never replaces them.
  if (legacy && originalIndex) await backupLegacyTask(projectId, "README.md", originalIndex)
  for (const { file } of changes) await backupLegacyTask(projectId, file.name, file.content)
  for (const { file, content } of changes) {
    await migrateTaskFile(resolveTaskFile(projectId, file.path), content, file.revision)
  }
  // Migration and imported tasks may need IDs/cache updates. Normal reads must
  // not rescan every document in the vault once for each project.
  if (changes.length > 0 || files.some((file) => !file.id)) {
    await documentIndex.reconcile()
  }
  const tasks = sortTasks(await readTaskFiles(projectId))
  const body = buildTaskIndexContent(tasks)
  if (parseFrontmatter(originalIndex).body.trim() !== body.trim()) {
    let currentIndex = ""
    try {
      currentIndex = await safeReadTextFile(target)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    await safeWriteTextFile(
      target,
      withDocumentBody(currentIndex, body),
      currentIndex ? { expectedRevision: documentRevision(currentIndex) } : {}
    )
  }
  return { path: `tasks/${TASKS_README_FILE}`, content: await safeReadTextFile(target) }
}

export function ensureTaskIndex(projectId) {
  return withTaskLock(projectId, () => ensureTaskIndexUnlocked(projectId))
}

// Explicit maintenance operation: only recover files matching the old task
// naming bug and recognizable task metadata. Ordinary reads never rename data.
export function repairTaskFileNames(projectId, { dryRun = true } = {}) {
  return withTaskLock(projectId, async () => {
    const dir = await safeLegacyDir(projectId, "tasks") ?? await safeLegacyDir(projectId, "plan")
    if (!dir) return { repairs: [], skipped: [] }
    const kind = path.basename(dir)
    const reserved = new Set()
    const plans = []
    const skipped = []
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.length < 140 || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z-[a-z0-9-]+(?:\.m?)?$/.test(entry.name)) continue
      const source = path.join(dir, entry.name)
      const buffer = await safeReadBuffer(source)
      let content
      try {
        if (buffer.includes(0)) throw new Error()
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer)
        const { data, body } = parseTaskFrontmatter(content)
        if (!String(data.title ?? "").trim() || !Number.isFinite(Date.parse(data.createdAt)) || !/^#\s+\S/m.test(body)) throw new Error()
      } catch {
        skipped.push({ path: `${kind}/${entry.name}`, reason: "Not recognizable as a UTF-8 Markdown task; inspect manually." })
        continue
      }
      // A crash between link and unlink can leave both names for the same file.
      // Reuse that destination on retry instead of creating a duplicate task.
      const sourceStat = await fs.stat(source)
      let target
      if (sourceStat.nlink > 1) {
        for (const candidate of entries.filter((item) => item.isFile() && isMarkdownName(item.name))) {
          const candidatePath = path.join(dir, candidate.name)
          const stat = await fs.stat(candidatePath)
          if (stat.dev === sourceStat.dev && stat.ino === sourceStat.ino) {
            target = candidatePath
            break
          }
        }
      }
      target ??= await uniquePathWithNumberSuffix(dir, `${entry.name.replace(/\.m?$/, "")}.md`, reserved)
      reserved.add(target)
      plans.push({ source, target, content })
    }
    const repairs = plans.map(({ source, target }) => ({ from: `${kind}/${path.basename(source)}`, to: `${kind}/${path.basename(target)}` }))
    if (dryRun || plans.length === 0) return { repairs, skipped }

    let indexPath
    let originalIndex
    for (const name of [TASKS_README_FILE, LEGACY_TASKS_README_FILE]) {
      try {
        indexPath = path.join(dir, name)
        originalIndex = await safeReadTextFile(indexPath)
        break
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
    // Keep a byte-for-byte source copy before any rename or index update.
    const backupDir = path.join(dir, ".filename-repair")
    await ensureSafeDir(backupDir)
    for (const [name, content] of [
      ...(originalIndex === undefined ? [] : [[path.basename(indexPath), originalIndex]]),
      ...plans.map(({ source, content }) => [path.basename(source), content])
    ]) {
      const backup = path.join(backupDir, name)
      await assertSafeWritableFile(vaultDir, backup)
      await fs.writeFile(backup, content, { flag: "wx" }).catch((error) => {
        if (error.code !== "EEXIST") throw error
      })
    }
    // Write a durable rename map, so an interrupted run can be inspected.
    await safeWriteTextFile(path.join(backupDir, `repair-${randomUUID()}.json`), `${JSON.stringify(repairs, null, 2)}\n`)
    if (originalIndex?.includes(TASK_INDEX_MARKER)) {
      // A prior migration omitted non-Markdown files from its generated index.
      // Recover their checkbox/assignment from the saved legacy index, while
      // preserving any explicit metadata already in the task itself.
      let legacyIndex = ""
      try {
        legacyIndex = await safeReadTextFile(path.join(dir, ".migration-v2", TASKS_README_FILE))
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
      const legacyItems = parseIndexItems(legacyIndex, kind, TASKS_README_FILE.toLowerCase())
      for (const plan of plans) {
        const item = legacyItems.find((item) => item.path === `${kind}/${path.basename(plan.source)}`)
        if (!item) continue
        const previous = parseTaskFrontmatter(plan.content).data
        const fields = {}
        if (!previous.status || previous.status === "open") fields.status = item.done ? "done" : "todo"
        if (!previous.owner && item.owner) fields.owner = item.owner
        if (!previous.deadline && item.deadline) fields.deadline = item.deadline
        if (Object.keys(fields).length) {
          // A resumed hard-link step must be recreated after atomic replacement
          // of the source, otherwise the destination would keep the old inode.
          const sourceStat = await fs.stat(plan.source)
          const targetStat = await fs.lstat(plan.target).catch((error) => {
            if (error.code !== "ENOENT") throw error
            return null
          })
          if (targetStat && sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) await fs.unlink(plan.target)
          const content = withDocumentFields(plan.content, fields)
          await migrateTaskFile(plan.source, content, documentRevision(plan.content))
          plan.content = content
        }
      }
    }
    if (originalIndex !== undefined) {
      const destinations = new Map(repairs.map(({ from, to }) => [from, path.basename(to)]))
      const nextIndex = originalIndex.replace(/(\]\()((?:\\.|[^)\\\r\n])+)(\))/g, (match, open, destination, close) => {
        const replacement = destinations.get(normalizeIndexPath(destination, kind, TASKS_README_FILE.toLowerCase()))
        return replacement ? `${open}${encodeURI(replacement)}${close}` : match
      })
      await migrateTaskFile(indexPath, nextIndex, documentRevision(originalIndex))
    }
    // Point the index at all destinations first. After an interruption the
    // remaining source files can be retried without losing their checkboxes.
    for (const { source, target, content } of plans) {
      if (documentRevision(await safeReadTextFile(source)) !== documentRevision(content)) {
        throw Object.assign(new Error("Task changed during filename repair. Stop writers and retry."), { statusCode: 409 })
      }
      // link is exclusive: an independently created destination is never replaced.
      try {
        await fs.link(source, target)
      } catch (error) {
        if (error.code !== "EEXIST") throw error
        const [left, right] = await Promise.all([fs.stat(source), fs.lstat(target)])
        if (right.isSymbolicLink() || left.dev !== right.dev || left.ino !== right.ino) throw error
      }
      await fs.unlink(source)
    }
    await documentIndex.reconcile()
    await appendSystemLogEvent({
      action: "task.filenames_repaired", source: "migration", actor: "migration", projectId,
      summary: `Repaired ${repairs.length} task filename(s)`, metadata: { repairs }
    })
    return { repairs, skipped }
  })
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

function ensureActivityLog(projectId) {
  return withActivityLock(projectId, () => ensureActivityLogUnlocked(projectId))
}

async function ensureActivityLogUnlocked(projectId) {
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

function appendActivityEntry(projectId, input) {
  return withActivityLock(projectId, () => appendActivityEntryUnlocked(projectId, input))
}

async function appendActivityEntryUnlocked(projectId, input) {
  await ensureProjectDirs(projectId)
  await ensureActivityLogUnlocked(projectId)

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
  await ensureSafeDir(path.join(vaultDir, "config"))
  await ensureSafeDir(path.join(vaultDir, "skills"))
  await ensureSafeDir(path.join(vaultDir, "automations"))
  const skillsConfigPath = path.join(vaultDir, "config", "skills.json")
  if (!existsSync(skillsConfigPath)) {
    await fs.writeFile(skillsConfigPath, `${JSON.stringify({ disabledSystemSkills: [] }, null, 2)}\n`, "utf8")
  }

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
      const [resources, work, tasks, activity] = await Promise.all([
        listProjectFiles(entry.name, RESOURCES_DIR),
        listProjectFiles(entry.name, WORK_DIR),
        listTasks(entry.name),
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
    // Reserve the project directory atomically, including concurrent MCP calls.
    await fs.mkdir(root)
  } catch (error) {
    if (error.code === "EEXIST") throw Object.assign(new Error("Project already exists"), { statusCode: 409 })
    throw error
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
    authenticatedBy: input?.authenticatedBy,
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
    await documentIndex.reconcile()
  }

  await writeProjectMetadata(nextProjectId, metadata)
  await appendSystemLogEvent({
    action: nextProjectId === projectId ? "project.updated" : "project.renamed",
    source: input?.source ?? "storage",
    authenticatedBy: input?.authenticatedBy,
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
    listTasks(projectId),
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
    authenticatedBy: input?.authenticatedBy,
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
    authenticatedBy: input?.authenticatedBy,
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
    authenticatedBy: input?.authenticatedBy,
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

async function appendMentionEventsForWrite(projectId, target, before, after, input = {}, targetType) {
  await appendMentionEvents({
    actor: String(input?.author ?? input?.editor ?? input?.creator ?? input?.createdBy ?? "team").trim() || "team",
    after,
    before,
    projectId,
    source: input?.source ?? "storage",
    authenticatedBy: input?.authenticatedBy,
    target,
    targetType,
  })
}

async function appendTaskAssignedEvent({
  actor,
  authenticatedBy,
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
    authenticatedBy,
    projectId,
    target,
    summary: `Assigned task ${title || "task"}`,
    metadata: {
      previousOwner: previousOwner || null,
      owner: nextOwner || null,
    },
  })
}

async function publishTaskEvent(type, projectId, task, input = {}) {
  const event = {
    type,
    projectId,
    payload: { task },
    actor: input.author ?? input.createdBy ?? "team",
    source: input.source ?? "storage"
  }
  await Promise.all(taskEvents.listeners("event").map((listener) => listener(event)))
}

async function taskRecord(projectId, relativePath) {
  const fullPath = resolveTaskFile(projectId, relativePath)
  const content = await safeReadTextFile(fullPath)
  const fields = parseTaskFrontmatter(content).data
  const { descriptionContent, comments } = splitTaskComments(content)
  const stat = await fs.stat(fullPath)
  const status = taskStatus(fields.status)
  return {
    id: fields.id,
    name: path.basename(fullPath),
    kind: "tasks",
    path: projectRelative(projectId, fullPath),
    title: String(fields.title || titleFromMarkdown(parseTaskFrontmatter(content).body) || path.parse(fullPath).name),
    owner: String(fields.owner ?? ""),
    deadline: String(fields.deadline ?? ""),
    status,
    order: taskOrder(fields.order),
    done: status === "done",
    createdAt: fields.createdAt ?? null,
    author: String(fields.createdBy ?? fields.creator ?? ""),
    createdBy: String(fields.createdBy ?? fields.creator ?? ""),
    updatedBy: String(fields.lastEditor ?? ""),
    tags: normalizeList(fields.tags),
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
    revision: documentRevision(content),
    content,
    descriptionContent,
    comments
  }
}

export function createTask(projectId, input = {}) {
  return withTaskLock(projectId, async () => {
    const tags = taskTags(input.tags)
    await ensureTaskIndexUnlocked(projectId)
    const title = String(input.title ?? "").trim()
    if (!title) throw Object.assign(new Error("Task title is required"), { statusCode: 400 })
    assertNoTaskCommentMarkers(`${title}\n${String(input.content ?? input.body ?? "")}`)
    const files = await readTaskFiles(projectId)
    const created = nowIso()
    const creator = String(input.createdBy ?? input.author ?? "team").trim() || "team"
    const fields = {
      title,
      createdAt: created,
      createdBy: creator,
      lastEditor: creator,
      lastEdited: created,
      owner: resolveTaskOwner(input.owner),
      deadline: normalizeTaskDeadline(input.deadline),
      tags,
      status: taskStatus(input.status),
      order: Math.max(-1, ...files.map((file) => file.order)) + 1
    }
    const target = await uniquePathWithNumberSuffix(
      path.join(projectPath(projectId), "tasks"),
      `${dateStamp(new Date(created))}-${slugify(title)}.md`
    )
    await safeWriteTextFile(
      target,
      markdownWithFrontmatter(`# ${title}\n\n${String(input.content ?? input.body ?? "").trim()}`, fields),
      { createOnly: true }
    )
    const task = await taskRecord(projectId, projectRelative(projectId, target))
    await ensureTaskIndexUnlocked(projectId)
    await appendActivityEntry(projectId, {
      createdAt: created,
      author: creator,
      title: `Created task ${title}`,
      content: `Created task: ${title} (${task.path}).`
    })
    await touchProject(projectId)
    await appendSystemLogEvent({
      action: "task.created",
      source: input.source ?? "storage",
      authenticatedBy: input?.authenticatedBy,
      actor: creator,
      projectId,
      target: task.path,
      summary: `Created task ${title}`,
      metadata: { status: task.status, owner: task.owner }
    })
    await appendMentionEventsForWrite(projectId, task.path, "", task.content, input, "task")
    await publishTaskEvent("task.added", projectId, task, input)
    return task
  })
}

export function appendTaskComment(projectId, relativePath, input = {}) {
  return withTaskLock(projectId, async () => {
    if (typeof input.content !== "string" || !input.content.trim()) {
      throw Object.assign(new Error("Comment content is required"), { statusCode: 400 })
    }
    const author = String(input.author ?? "team").trim() || "team"
    if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(author)) {
      throw Object.assign(new Error("Comment author must be a single-line name"), { statusCode: 400 })
    }
    assertNoTaskCommentMarkers(input.content)
    resolveTaskFile(projectId, relativePath)
    if (!(await safeLegacyDir(projectId, ""))) {
      throw Object.assign(new Error("Project not found"), { statusCode: 404 })
    }
    await ensureTaskIndexUnlocked(projectId)
    const existing = await taskRecord(projectId, relativePath)
    const comment = { id: randomUUID(), author, createdAt: nowIso(), content: input.content.trim() }
    const content = withDocumentFields(withTaskComment(existing.content, comment), {
      lastEditor: author, lastEdited: comment.createdAt
    })
    await safeWriteTextFile(resolveTaskFile(projectId, relativePath), content, { expectedRevision: existing.revision })
    const task = await taskRecord(projectId, relativePath)
    await touchProject(projectId)
    await appendSystemLogEvent({
      action: "task.comment_added", source: input.source ?? "storage", actor: author,
      authenticatedBy: input.authenticatedBy, projectId, target: task.path,
      summary: `Commented on task ${task.title}`, metadata: { commentId: comment.id }
    })
    await appendMentionEventsForWrite(projectId, task.path, "", comment.content, { ...input, author }, "task")
    await publishTaskEvent("task.updated", projectId, task, { ...input, author })
    return { comment, path: task.path, revision: task.revision, task }
  })
}

export async function updateTaskIndex() {
  throw Object.assign(
    new Error(
      "Task index is generated and read-only. Update individual tasks or use tasks/order with current revisions."
    ),
    { statusCode: 400 }
  )
}

export function reorderTasks(projectId, input = {}) {
  return withTaskLock(projectId, async () => {
    await ensureTaskIndexUnlocked(projectId)
    const files = sortTasks(await readTaskFiles(projectId))
    const items = input.items
    if (
      !Array.isArray(items) ||
      items.length !== files.length ||
      new Set(items.map((item) => item.path)).size !== files.length
    ) {
      throw Object.assign(new Error("Task list changed. Reload before reordering."), { statusCode: 409 })
    }
    const byPath = new Map(files.map((file) => [file.path, file]))
    for (const item of items) {
      requireTaskRevision(item)
      if (!byPath.has(item.path) || byPath.get(item.path).revision !== item.expectedRevision) {
        throw Object.assign(new Error("Task changed. Reload before reordering."), { statusCode: 409 })
      }
    }
    for (const [order, item] of items.entries()) {
      const file = byPath.get(item.path)
      if (file.order !== order) {
        await safeWriteTextFile(
          resolveTaskFile(projectId, item.path),
          withDocumentFields(file.content, { order, lastEditor: input.author ?? "team", lastEdited: nowIso() }),
          { expectedRevision: item.expectedRevision }
        )
      }
    }
    await ensureTaskIndexUnlocked(projectId)
    await touchProject(projectId)
    await appendSystemLogEvent({
      action: "task.reordered",
      source: input.source ?? "storage",
      authenticatedBy: input?.authenticatedBy,
      actor: input.author ?? "team",
      projectId,
      summary: "Reordered tasks",
      metadata: { paths: items.map((item) => item.path) }
    })
    await publishTaskEvent("task.reordered", projectId, { paths: items.map((item) => item.path) }, input)
    return listTaskRecordsUnlocked(projectId)
  })
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
    logContent = `Long update archived as [${markdownLinkLabel(title)}](../${artifactPath}).`
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
    authenticatedBy: input?.authenticatedBy,
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
    authenticatedBy: input?.authenticatedBy,
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
    authenticatedBy: input?.authenticatedBy,
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
  await documentIndex.reconcile()
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "file.moved",
    source: input?.source ?? "storage",
    authenticatedBy: input?.authenticatedBy,
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
  if (!/\.md$/i.test(relativePath)) throw Object.assign(new Error("Only Markdown task files are supported"), { statusCode: 400 })
  return resolveProjectSubdirFile(projectId, relativePath, "tasks", "Only task files can be changed", isTaskIndexPath)
}

function resolveGeneratedFile(projectId, relativePath) {
  return resolveProjectSubdirFile(projectId, relativePath, WORK_DIR, "Only work files can be changed")
}

export async function deleteArtifact(projectId, relativePath, input = {}) {
  await ensureProjectDirs(projectId)
  const fullPath = resolveArtifactFile(projectId, relativePath)
  await safeUnlinkFile(fullPath)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.deleted",
    source: input.source ?? "storage",
    authenticatedBy: input?.authenticatedBy,
    actor: input.author ?? "team",
    projectId,
    target: projectRelative(projectId, fullPath),
    summary: `Deleted resource ${path.basename(fullPath)}`,
  })

  return {
    path: relativePath,
    deleted: true,
  }
}

export function deleteTask(projectId, relativePath, input = {}) {
  return withTaskLock(projectId, async () => {
    requireTaskRevision(input)
    await ensureTaskIndexUnlocked(projectId)
    const task = await taskRecord(projectId, relativePath)
    if (task.revision !== input.expectedRevision)
      throw Object.assign(new Error("Task changed. Read it again before deleting."), { statusCode: 409 })
    await safeUnlinkFile(resolveTaskFile(projectId, relativePath))
    await ensureTaskIndexUnlocked(projectId)
    await touchProject(projectId)
    await appendSystemLogEvent({
      action: "task.deleted",
      source: input.source ?? "storage",
      authenticatedBy: input?.authenticatedBy,
      actor: input.author ?? "team",
      projectId,
      target: task.path,
      summary: `Deleted task ${task.title}`
    })
    await publishTaskEvent("task.deleted", projectId, task, input)
    return { path: task.path, deleted: true }
  })
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
  await documentIndex.reconcile()
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "artifact.renamed",
    source: input?.source ?? "storage",
    authenticatedBy: input?.authenticatedBy,
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
    authenticatedBy: input?.authenticatedBy,
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
    authenticatedBy: input?.authenticatedBy,
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
    authenticatedBy: input?.authenticatedBy,
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
  let content = markdownWithFrontmatter(incoming.body, {
    ...existing.fields,
    ...incoming.fields,
    lastEdited,
    lastEditor,
  })

  content = await safeWriteTextFile(fullPath, content, { expectedRevision: input.expectedRevision })
  await touchProject(projectId)
  await appendMentionEventsForWrite(projectId, projectRelative(projectId, fullPath), existingRaw, content, input)

  return {
    path: projectRelative(projectId, fullPath),
    size: Buffer.byteLength(content, "utf8"),
    content,
  }
}

async function updateTaskUnlocked(projectId, relativePath, input = {}) {
  requireTaskRevision(input)
  await ensureTaskIndexUnlocked(projectId)
  const existing = await taskRecord(projectId, relativePath)
  if (existing.revision !== input.expectedRevision)
    throw Object.assign(new Error("Task changed since it was read. Read it again before updating."), {
      statusCode: 409
    })
  const incoming = typeof input.content === "string" ? parseTaskFrontmatter(input.content) : { data: {}, body: "" }
  const values = {
    ...incoming.data,
    ...Object.fromEntries(
      ["title", "owner", "deadline", "status"].filter((key) => input[key] !== undefined).map((key) => [key, input[key]])
    )
  }
  const fields = { lastEditor: input.author ?? input.editor ?? "team", lastEdited: nowIso() }
  if (input.title !== undefined || typeof input.content === "string") {
    fields.title = String(input.title ?? titleFromMarkdown(incoming.body) ?? values.title ?? existing.title).trim()
    if (!fields.title) throw Object.assign(new Error("Task title is required"), { statusCode: 400 })
  }
  if (values.status !== undefined) fields.status = taskStatus(values.status)
  if (values.owner !== undefined) fields.owner = resolveTaskOwner(values.owner)
  if (values.deadline !== undefined) fields.deadline = normalizeTaskDeadline(values.deadline)
  if (input.tags !== undefined) fields.tags = taskTags(input.tags)
  // Order is changed only through reorderTasks, with a revision check for every task.
  let content = existing.descriptionContent
  if (typeof input.content === "string") {
    const header = input.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[0]
    if (header)
      content = withDocumentFields(input.content, {
        ...fields,
        status: fields.status ?? existing.status,
        owner: fields.owner ?? existing.owner,
        deadline: fields.deadline ?? existing.deadline,
        order: existing.order
      })
    else content = withDocumentBody(content, input.content)
  } else if (input.body !== undefined) {
    content = withDocumentBody(content, `\n# ${fields.title ?? existing.title}\n\n${String(input.body)}\n`)
  } else if (fields.title && fields.title !== existing.title) {
    const body = parseFrontmatter(content).body
    content = withDocumentBody(content, body.replace(/^#\s+.*$/m, `# ${fields.title}`))
  }
  content = preserveTaskComments(existing.content, content)
  content = withDocumentFields(content, fields)
  await safeWriteTextFile(resolveTaskFile(projectId, relativePath), content, {
    expectedRevision: input.expectedRevision
  })
  await ensureTaskIndexUnlocked(projectId)
  const task = await taskRecord(projectId, relativePath)
  await touchProject(projectId)
  await appendSystemLogEvent({
    action: "task.updated",
    source: input.source ?? "storage",
    authenticatedBy: input?.authenticatedBy,
    actor: input.author ?? "team",
    projectId,
    target: task.path,
    summary: `Updated task ${task.title}`
  })
  await appendTaskAssignedEvent({
    actor: input.author ?? "team",
    authenticatedBy: input.authenticatedBy,
    projectId,
    source: input.source,
    target: task.path,
    title: task.title,
    previousOwner: existing.owner,
    nextOwner: task.owner
  })
  if (existing.status !== task.status) {
    await appendSystemLogEvent({
      action: "task.status_changed",
      source: input.source ?? "storage",
      authenticatedBy: input?.authenticatedBy,
      actor: input.author ?? "team",
      projectId,
      target: task.path,
      summary: `Task ${task.title}: ${existing.status} → ${task.status}`,
      metadata: { previousStatus: existing.status, status: task.status }
    })
    await publishTaskEvent("task.status_changed", projectId, task, input)
  }
  await appendMentionEventsForWrite(projectId, task.path, existing.content, task.content, input, "task")
  if (existing.owner !== task.owner) await publishTaskEvent("task.assigned", projectId, task, input)
  await publishTaskEvent("task.updated", projectId, task, input)
  return task
}

export function updateTask(projectId, relativePath, input = {}) {
  return withTaskLock(projectId, () => updateTaskUnlocked(projectId, relativePath, input))
}

export function toggleTask(projectId, relativePath, done, input = {}) {
  return withTaskLock(projectId, async () => {
    requireTaskRevision(input)
    await ensureTaskIndexUnlocked(projectId)
    const existing = await taskRecord(projectId, relativePath)
    const nextDone = done === undefined ? existing.status !== "done" : Boolean(done)
    return updateTaskUnlocked(projectId, relativePath, { ...input, status: nextDone ? "done" : "todo" })
  })
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

async function listTaskRecordsUnlocked(projectId, { compact = true } = {}) {
  return sortTasks(await readTaskFiles(projectId)).map(({ content, ...file }) => ({
    ...file,
    done: file.status === "done",
    ...(compact ? {} : { content })
  }))
}

function taskListOptions(input) {
  function boolean(name, fallback) {
    const value = input[name]
    if (value === undefined) return fallback
    if (value === true || value === "true") return true
    if (value === false || value === "false") return false
    throw Object.assign(new Error(`${name} must be true or false`), { statusCode: 400 })
  }
  for (const name of ["owner", "createdBy", "updatedSince", "cursor", "tag"]) {
    if (input[name] !== undefined && typeof input[name] !== "string") {
      throw Object.assign(new Error(`${name} must be a string`), { statusCode: 400 })
    }
  }
  const paged = input.limit !== undefined || input.cursor !== undefined
  const limit = input.limit === undefined ? 50 : Number(input.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw Object.assign(new Error("limit must be an integer between 1 and 100"), { statusCode: 400 })
  }
  let updatedSince
  if (input.updatedSince !== undefined) {
    updatedSince = Date.parse(input.updatedSince)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.updatedSince) || !Number.isFinite(updatedSince)) {
      throw Object.assign(new Error("updatedSince must be an ISO timestamp with a timezone"), { statusCode: 400 })
    }
  }
  return {
    done: boolean("done"), overdue: boolean("overdue"), compact: boolean("compact", true),
    status: input.status === undefined ? undefined : taskStatus(input.status),
    owner: input.owner, createdBy: input.createdBy, tag: input.tag?.trim() || undefined, updatedSince,
    paged, limit, cursor: input.cursor
  }
}

export function listTasks(projectId, options = {}) {
  return withTaskLock(projectId, async () => {
    const query = taskListOptions(options)
    await ensureTaskIndexUnlocked(projectId)
    const today = nowIso().slice(0, 10)
    const tasks = (await listTaskRecordsUnlocked(projectId, query)).filter((task) => {
      const overdue = Boolean(task.deadline && task.deadline < today && !["done", "rejected"].includes(task.status))
      return (query.done === undefined || task.done === query.done) &&
        (query.status === undefined || task.status === query.status) &&
        (query.owner === undefined || task.owner === query.owner) &&
        (query.createdBy === undefined || task.createdBy === query.createdBy) &&
        (query.tag === undefined || task.tags.includes(query.tag)) &&
        (query.overdue === undefined || overdue === query.overdue) &&
        (query.updatedSince === undefined || Date.parse(task.updatedAt) > query.updatedSince)
    })
    if (!query.paged) return tasks

    // Bind a cursor to this query and its matching records. Reject changed
    // snapshots rather than skipping/duplicating tasks after edits or reorders.
    const snapshot = documentRevision(JSON.stringify({
      projectId, done: query.done, status: query.status, owner: query.owner,
      createdBy: query.createdBy, tag: query.tag, overdue: query.overdue, updatedSince: query.updatedSince,
      compact: query.compact, today: query.overdue === undefined ? undefined : today,
      tasks: tasks.map((task) => [task.path, task.revision, task.updatedAt])
    }))
    let offset = 0
    if (query.cursor !== undefined) {
      let cursor
      try {
        if (!/^[A-Za-z0-9_-]{1,512}$/.test(query.cursor)) throw new Error()
        cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))
        if (!cursor || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1 || !/^[0-9a-f]{64}$/.test(cursor.snapshot)) throw new Error()
      } catch {
        throw Object.assign(new Error("Invalid task cursor"), { statusCode: 400 })
      }
      if (cursor.snapshot !== snapshot || cursor.offset >= tasks.length) {
        throw Object.assign(new Error("Task list or filters changed. Restart pagination without a cursor."), { statusCode: 409 })
      }
      offset = cursor.offset
    }
    const end = offset + query.limit
    return {
      items: tasks.slice(offset, end),
      nextCursor: end < tasks.length
        ? Buffer.from(JSON.stringify({ offset: end, snapshot })).toString("base64url")
        : null
    }
  })
}

export async function listAllTasks() {
  await ensureDataDir()
  const entries = (await fs.readdir(dataDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  const items = []
  // Migration reconciles document IDs across the vault, so visit projects in order.
  for (const entry of entries) {
    const project = await getProjectMetadata(entry.name)
    items.push(
      ...(await listTasks(project.id)).map((task) => ({
        ...task,
        projectId: project.id,
        projectName: project.name
      }))
    )
  }
  return items
}

export function readTask(projectId, relativePath) {
  return withTaskLock(projectId, async () => {
    await ensureTaskIndexUnlocked(projectId)
    return taskRecord(projectId, relativePath)
  })
}

export async function readDocFile(docId, relativePath) {
  const fullPath = resolveDocFile(docId, relativePath)
  await assertSafeExistingFile(vaultDir, fullPath)

  return {
    path: docRelative(docId, fullPath),
    content: await safeReadTextFile(fullPath),
  }
}

export async function readDocument(input = {}) {
  if (input.ref) return documentIndex.read(input.ref)
  if (Boolean(input.projectId) === Boolean(input.docId)) {
    throw Object.assign(new Error("Specify ref, or exactly one of projectId/docId with path"), { statusCode: 400 })
  }
  if (typeof input.path !== "string" || !input.path) throw Object.assign(new Error("Document path is required"), { statusCode: 400 })
  if (input.projectId && input.path.startsWith("tasks/")) await ensureTaskIndex(input.projectId)
  const target = input.projectId ? resolveProjectFile(input.projectId, input.path) : resolveDocFile(input.docId, input.path)
  await assertSafeExistingFile(vaultDir, target)
  return documentIndex.byPath(target)
}

export async function createDocument(input = {}) {
  if (Boolean(input.projectId) === Boolean(input.docId)) {
    throw Object.assign(new Error("Specify exactly one of projectId or docId"), { statusCode: 400 })
  }
  const title = String(input.title ?? "").trim()
  const content = String(input.content ?? "").trim()
  if (!title || !content) throw Object.assign(new Error("Title and content are required"), { statusCode: 400 })
  let directory
  if (input.projectId) {
    await ensureProjectDirs(input.projectId)
    const area = input.area ?? RESOURCES_DIR
    if (![RESOURCES_DIR, WORK_DIR].includes(area)) throw Object.assign(new Error("Document area must be resources or work"), { statusCode: 400 })
    directory = await ensureProjectSubdir(input.projectId, area, input.folder)
  } else {
    assertDocId(input.docId)
    directory = docPath(input.docId)
    await ensureSafeDir(directory)
    const folder = String(input.folder ?? "").replaceAll("\\", "/")
    if (folder.split("/").some((part) => part === ".." || part === ".")) throw storagePathError()
    for (const part of folder.split("/").filter(Boolean)) {
      directory = path.join(directory, part)
      await ensureSafeDir(directory)
    }
  }
  const creator = String(input.author ?? "team")
  const timestamp = nowIso()
  const parsed = parseFrontmatter(content)
  const markdown = markdownDocument(title, parsed.body.replace(/^#\s+.*(?:\r?\n|$)/, "").trim(), {
    type: "text", creator, created: timestamp, lastEditor: creator, lastEdited: timestamp, tags: normalizeList(input.tags),
  })
  let target
  for (let attempt = 0; attempt < 100; attempt++) {
    target = await uniquePathWithNumberSuffix(directory, `${dateStamp()}-${slugify(title)}.md`)
    try {
      await safeWriteTextFile(target, markdown, { createOnly: true })
      break
    } catch (error) {
      if (error.code !== "EEXIST" || attempt === 99) throw error
    }
  }
  if (input.projectId) {
    const relative = projectRelative(input.projectId, target)
    await appendActivityEntry(input.projectId, { author: creator, kind: "artifact", artifactPath: relative, title: `Added ${title}`, content: `Added document [${markdownLinkLabel(title)}](../${relative}).` })
    await touchProject(input.projectId)
    await appendMentionEventsForWrite(input.projectId, relative, "", await safeReadTextFile(target), input)
  }
  await appendSystemLogEvent({ action: "document.created", source: input.source ?? "storage", actor: creator, authenticatedBy: input.authenticatedBy, projectId: input.projectId, target: path.relative(vaultDir, target), summary: `Created document ${title}` })
  return documentIndex.byPath(target)
}

export async function updateDocument(input = {}) {
  const existing = await readDocument(input)
  if (typeof input.content !== "string") throw Object.assign(new Error("Content is required"), { statusCode: 400 })
  if (input.title !== undefined && !String(input.title).trim()) throw Object.assign(new Error("Title must not be empty"), { statusCode: 400 })
  const target = existing.projectId ? resolveProjectFile(existing.projectId, existing.path) : resolveDocFile(existing.docId, existing.path)
  if (existing.kind === "logs") throw Object.assign(new Error("Activity logs are append-only"), { statusCode: 400 })
  const incoming = parseFrontmatter(input.content)
  const body = input.title === undefined ? incoming.body : `# ${String(input.title).trim()}\n\n${incoming.body.replace(/^#\s+.*(?:\r?\n|$)/, "").trim()}`
  const fields = { lastEditor: input.author ?? "team", lastEdited: nowIso() }
  if (input.title !== undefined) fields.title = String(input.title).trim()
  if (input.tags !== undefined) fields.tags = normalizeList(input.tags)
  if (existing.kind === "tasks" && !isTaskIndexPath(existing.path)) {
    await updateTask(existing.projectId, existing.path, { ...input, content: withDocumentFields(withDocumentBody(existing.content, body), fields) })
  } else {
    if (existing.kind === "tasks") throw Object.assign(new Error("Use task tools to update the task index"), { statusCode: 400 })
    await safeWriteTextFile(target, withDocumentFields(withDocumentBody(existing.content, body), fields), { expectedRevision: input.expectedRevision })
    if (existing.projectId) {
      await touchProject(existing.projectId)
      await appendMentionEventsForWrite(existing.projectId, existing.path, existing.content, input.content, input)
    }
  }
  await appendSystemLogEvent({ action: "document.updated", source: input.source ?? "storage", actor: input.author ?? "team", authenticatedBy: input.authenticatedBy, projectId: existing.projectId, target: path.relative(vaultDir, target), summary: `Updated document ${existing.id}` })
  return documentIndex.byPath(target)
}

export async function writeProjectMarkdownFile(projectId, relativePath, content, input = {}) {
  const target = resolveProjectFile(projectId, relativePath)
  if (!relativePath.startsWith("work/")) throw storagePathError()
  await safeWriteTextFile(target, withDocumentFields(content, { creator: input.author ?? "agent", created: nowIso(), lastEditor: input.author ?? "agent", lastEdited: nowIso() }), { createOnly: true })
  return documentIndex.byPath(target)
}

export async function createDocFileStream(docId, relativePath) {
  return safeReadStream(resolveDocFile(docId, relativePath))
}

export async function searchFiles(options = {}) {
  await ensureDataDir()
  return documentIndex.search(options)
}
