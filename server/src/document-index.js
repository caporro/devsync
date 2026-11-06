import { createHash, randomInt, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseFrontmatter, normalizeList } from "./markdown-definitions.js"

const ID_PATTERN = /^[0-9a-z]{5}$/
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const PROTECTED_FIELDS = ["id", "created", "createdAt", "creator", "createdBy"]

function error(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode })
}

export function documentRevision(content) {
  return createHash("sha256").update(content).digest("hex")
}

// Edit only the specified fields; preserve other YAML and the Markdown body.
export function withDocumentFields(content, fields) {
  const raw = String(content)
  const match = raw.match(FRONTMATTER)
  let header = match?.[1] ?? ""
  for (const [key, value] of Object.entries(fields)) {
    const line = new RegExp(`^${key}:[^\\r\\n]*(?:\\r?\\n|$)`, "gm")
    header = header.replace(line, "")
    if (value !== undefined && value !== null && value !== "") {
      header = `${header.trimEnd()}\n${key}: ${JSON.stringify(value)}`.trimStart()
    }
  }
  return `---\n${header.trimEnd()}\n---\n${match ? raw.slice(match[0].length) : raw}`
}

export function withDocumentBody(content, body) {
  return `${String(content).match(FRONTMATTER)?.[0] ?? ""}${body}`
}

export function referenceId(reference) {
  const value = String(reference ?? "").trim()
  if (ID_PATTERN.test(value)) return value
  if (/^\/d\/[0-9a-z]{5}$/.test(value)) return value.slice(3)
  let url
  try { url = new URL(value) } catch { throw error("Expected a document ID, /d/ID, HTTP URL or devsync://document/ID") }
  if (["http:", "https:"].includes(url.protocol) && /^\/d\/[0-9a-z]{5}\/?$/.test(url.pathname)) {
    return url.pathname.split("/")[2]
  }
  if (url.protocol === "devsync:" && ["document", "documents"].includes(url.hostname) && /^\/[0-9a-z]{5}$/.test(url.pathname)) {
    return url.pathname.slice(1)
  }
  throw error("Invalid document reference")
}

export function createDocumentIndex({ vaultDir, projectsDir, docsDir }) {
  let db
  let initialized = false
  let queue = Promise.resolve()
  function serial(operation) {
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }

  function describe(target) {
    if (path.extname(target).toLowerCase() !== ".md") return null
    const relative = path.relative(vaultDir, target).split(path.sep).join("/")
    const projectRelative = path.relative(projectsDir, target).split(path.sep).join("/")
    const project = projectRelative.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/(README\.md|(?:resources|artifacts|work|generated|tasks|plan|logs)\/.+\.md)$/i)
    if (project) {
      const publicPath = project[2].replace(/^artifacts\//, "resources/").replace(/^generated\//, "work/").replace(/^plan\//, "tasks/")
      return { relative, projectId: project[1], docId: null, path: publicPath, kind: publicPath.includes("/") ? publicPath.split("/")[0] : "readme" }
    }
    const docRelative = path.relative(docsDir, target).split(path.sep).join("/")
    const doc = docRelative.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/(.+\.md)$/i)
    if (doc && !docRelative.split("/").includes("..")) {
      return { relative, projectId: null, docId: doc[1], path: doc[2], kind: "docs" }
    }
    return null
  }

  async function assertSafe(target, allowMissing = false) {
    const relative = path.relative(vaultDir, target)
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw error("Invalid document path")
    let current = vaultDir
    for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part)
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw error("Symbolic links are not supported for documents")
      } catch (cause) {
        if (allowMissing && cause.code === "ENOENT" && current === target) return
        throw cause
      }
    }
  }

  async function existingPath(target) {
    const [root, real] = await Promise.all([fs.realpath(vaultDir), fs.realpath(target)])
    const relative = path.relative(root, real)
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw error("Invalid document path")
    // Use the filename's actual casing, retaining the configured vault root alias.
    return path.join(vaultDir, relative)
  }

  async function database() {
    if (db) return db
    const cache = path.join(vaultDir, ".devsync")
    await assertSafe(cache, true)
    await fs.mkdir(cache, { recursive: true })
    await assertSafe(cache)
    const file = path.join(cache, "search.sqlite")
    for (const suffix of ["", "-wal", "-shm"]) await assertSafe(`${file}${suffix}`, true)
    await fs.writeFile(path.join(cache, ".gitignore"), "*\n", { flag: "wx" }).catch((cause) => {
      if (cause.code !== "EEXIST") throw cause
    })
    const connection = new DatabaseSync(file, { timeout: 5000 })
    try {
      connection.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS documents (
          rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, relative TEXT NOT NULL UNIQUE,
          projectId TEXT, docId TEXT, path TEXT NOT NULL, kind TEXT NOT NULL,
          author TEXT NOT NULL, tags TEXT NOT NULL, title TEXT NOT NULL,
          mtime REAL NOT NULL, ctime REAL NOT NULL, size INTEGER NOT NULL, revision TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
          title, filename, tags, body, tokenize='unicode61 remove_diacritics 2'
        );
      `)
      db = connection
    } catch (cause) {
      connection.close()
      throw cause
    }
    return db
  }

  function newId(connection) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = Array.from({ length: 5 }, () => ALPHABET[randomInt(36)]).join("")
      if (!connection.prepare("SELECT 1 FROM documents WHERE id = ?").get(id)) return id
    }
    throw error("Could not allocate a unique document ID", 503)
  }

  async function atomicWrite(target, content, stat, expectedRevision) {
    await assertSafe(target, true)
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, content, { flag: "wx", mode: stat?.mode ?? 0o600 })
      if (stat) {
        if (documentRevision(await fs.readFile(target, "utf8")) !== expectedRevision) throw error("Document changed during the write; retry after reading it again", 409)
        await fs.rename(temporary, target)
      } else {
        // Linking a new file is exclusive, so concurrent publishers cannot overwrite it.
        await fs.link(temporary, target)
      }
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }

  async function upsert(connection, target, raw, stat) {
    const location = describe(target)
    const { data, body } = parseFrontmatter(raw)
    if (!ID_PATTERN.test(String(data.id ?? ""))) throw error(`Invalid document ID in ${location.relative}`, 409)
    const duplicate = connection.prepare("SELECT relative FROM documents WHERE id = ? AND relative <> ?").get(data.id, location.relative)
    if (duplicate) throw error(`Duplicate document ID ${data.id}: ${duplicate.relative} and ${location.relative}`, 409)
    const tags = normalizeList(data.tags)
    const title = String(data.title || body.match(/^#\s+(.+)$/m)?.[1] || path.parse(target).name)
    const author = String(data.creator || data.createdBy || "")
    const revision = documentRevision(raw)
    connection.prepare(`INSERT INTO documents (id, relative, projectId, docId, path, kind, author, tags, title, mtime, ctime, size, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(relative) DO UPDATE SET id=excluded.id, projectId=excluded.projectId, docId=excluded.docId,
      path=excluded.path, kind=excluded.kind, author=excluded.author, tags=excluded.tags, title=excluded.title,
      mtime=excluded.mtime, ctime=excluded.ctime, size=excluded.size, revision=excluded.revision`).run(
      data.id, location.relative, location.projectId, location.docId, location.path, location.kind,
      author, JSON.stringify(tags), title, stat.mtimeMs, stat.ctimeMs, stat.size, revision,
    )
    const { rowid } = connection.prepare("SELECT rowid FROM documents WHERE relative = ?").get(location.relative)
    connection.prepare("DELETE FROM document_fts WHERE rowid = ?").run(rowid)
    connection.prepare("INSERT INTO document_fts(rowid, title, filename, tags, body) VALUES (?, ?, ?, ?, ?)").run(rowid, title, path.basename(target), tags.join(" "), body)
    return publicDocument(connection.prepare("SELECT * FROM documents WHERE rowid = ?").get(rowid))
  }

  function publicDocument(row) {
    const { relative, rowid, mtime, ctime, ...result } = row
    return { ...result, tags: JSON.parse(row.tags), name: path.posix.basename(row.path), updatedAt: new Date(mtime).toISOString(), url: `/d/${row.id}`, ref: `devsync://document/${row.id}` }
  }

  async function scan() {
    const files = []
    async function walk(directory) {
      await assertSafe(directory)
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(target)
        else if (entry.isFile() && describe(target)) files.push(target)
      }
    }
    for (const root of [projectsDir, docsDir]) {
      try { await walk(root) } catch (cause) { if (cause.code !== "ENOENT") throw cause }
    }
    return files.sort()
  }

  async function reconcileNow() {
    const connection = await database()
    const files = await scan()
    const present = new Set(files.map((file) => describe(file).relative))
    connection.exec("BEGIN IMMEDIATE")
    try {
      // Remove stale locations first, so a move keeps its ID without a false duplicate.
      for (const row of connection.prepare("SELECT rowid, relative FROM documents").all()) {
        if (!present.has(row.relative)) {
          connection.prepare("DELETE FROM document_fts WHERE rowid = ?").run(row.rowid)
          connection.prepare("DELETE FROM documents WHERE rowid = ?").run(row.rowid)
        }
      }
      const pending = []
      const reserved = new Map()
      for (const target of files) {
        await assertSafe(target)
        const stat = await fs.stat(target)
        const relative = describe(target).relative
        const previous = connection.prepare("SELECT * FROM documents WHERE relative = ?").get(relative)
        if (previous && previous.mtime === stat.mtimeMs && previous.ctime === stat.ctimeMs && previous.size === stat.size) {
          reserved.set(previous.id, relative)
          continue
        }
        const raw = await fs.readFile(target, "utf8")
        const id = parseFrontmatter(raw).data.id
        if (id && !ID_PATTERN.test(String(id))) throw error(`Invalid document ID in ${relative}`, 409)
        if (id && reserved.has(id) && reserved.get(id) !== relative) throw error(`Duplicate document ID ${id}`, 409)
        if (id) reserved.set(id, relative)
        pending.push({ target, raw, stat, id, previousId: previous?.id })
      }
      // Reserve every existing ID before assigning IDs to legacy/imported files.
      for (const item of pending) {
        let { raw, stat, id } = item
        if (!id) {
          if (item.previousId) id = item.previousId
          else do { id = newId(connection) } while (reserved.has(id))
          if (reserved.has(id) && reserved.get(id) !== describe(item.target).relative) throw error(`Duplicate document ID ${id}`, 409)
          reserved.set(id, describe(item.target).relative)
          raw = withDocumentFields(raw, { id })
          await atomicWrite(item.target, raw, stat, documentRevision(item.raw))
          await fs.utimes(item.target, stat.atime, stat.mtime)
          stat = await fs.stat(item.target)
        }
        await upsert(connection, item.target, raw, stat)
      }
      connection.exec("COMMIT")
      initialized = true
    } catch (cause) {
      connection.exec("ROLLBACK")
      throw cause
    }
  }

  return {
    recognizes: (target) => Boolean(describe(target)),
    reconcile: () => serial(reconcileNow),
    rebuild: () => serial(async () => {
      const connection = await database()
      connection.exec("BEGIN IMMEDIATE")
      try {
        connection.exec("DELETE FROM document_fts; DELETE FROM documents; COMMIT")
      } catch (cause) { connection.exec("ROLLBACK"); throw cause }
      initialized = false
      await reconcileNow()
    }),
    write: (target, content, { append = false, expectedRevision, createOnly = false } = {}) => serial(async () => {
      if (!initialized) await reconcileNow()
      const connection = await database()
      await assertSafe(target, true)
      let exists = true
      try { await fs.stat(target) } catch (cause) { if (cause.code === "ENOENT") exists = false; else throw cause }
      if (exists) target = await existingPath(target)
      // Reserve IDs imported since the last scan before allocating an ID for a new file.
      if (!exists || !connection.prepare("SELECT 1 FROM documents WHERE relative = ?").get(describe(target).relative)) await reconcileNow()
      connection.exec("BEGIN IMMEDIATE")
      try {
        await assertSafe(target, true)
        let before = ""
        let stat
        try { stat = await fs.stat(target); before = await fs.readFile(target, "utf8") } catch (cause) { if (cause.code !== "ENOENT") throw cause }
        if (createOnly && stat) throw Object.assign(error("Document already exists", 409), { code: "EEXIST" })
        if (expectedRevision !== undefined && expectedRevision !== documentRevision(before)) throw error("Document changed since it was read. Read it again before updating.", 409)
        const existing = parseFrontmatter(before).data
        const protectedFields = Object.fromEntries(PROTECTED_FIELDS.map((key) => [key, existing[key]]))
        const known = connection.prepare("SELECT id FROM documents WHERE relative = ?").get(describe(target).relative)
        const id = existing.id || known?.id || newId(connection)
        if (!ID_PATTERN.test(String(id))) throw error("Invalid document ID", 409)
        const duplicate = connection.prepare("SELECT relative FROM documents WHERE id = ? AND relative <> ?").get(id, describe(target).relative)
        if (duplicate) throw error(`Duplicate document ID ${id}`, 409)
        const raw = withDocumentFields(append ? before + content : content, { ...protectedFields, id,
          ...(!stat ? Object.fromEntries(PROTECTED_FIELDS.filter((key) => key !== "id").map((key) => [key, parseFrontmatter(content).data[key]])) : {}),
        })
        await atomicWrite(target, raw, stat, documentRevision(before))
        await upsert(connection, target, raw, await fs.stat(target))
        connection.exec("COMMIT")
        return raw
      } catch (cause) {
        connection.exec("ROLLBACK")
        throw cause
      }
    }),
    read: (reference) => serial(async () => {
      await reconcileNow()
      const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(referenceId(reference))
      if (!row) throw error("Document not found", 404)
      const target = path.join(vaultDir, row.relative)
      await assertSafe(target)
      const content = await fs.readFile(target, "utf8")
      return { ...publicDocument(row), content, revision: documentRevision(content) }
    }),
    byPath: (target) => serial(async () => {
      await assertSafe(target)
      target = await existingPath(target)
      if (!describe(target)) throw error("Only Markdown documents can be referenced")
      await reconcileNow()
      const row = db.prepare("SELECT * FROM documents WHERE relative = ?").get(describe(target).relative)
      if (!row) throw error("Document not found", 404)
      const content = await fs.readFile(target, "utf8")
      return { ...publicDocument(row), content, revision: documentRevision(content) }
    }),
    search: (options = {}) => serial(async () => {
      if (!initialized) await reconcileNow()
      const tokens = String(options.query ?? "").match(/[\p{L}\p{N}_]+/gu) ?? []
      if (!tokens.length) return []
      // Plain text only: every token must match. Punctuation is never FTS syntax.
      const query = tokens.map((token) => `"${token}"`).join(" AND ")
      const conditions = ["document_fts MATCH ?"]
      const parameters = [query]
      for (const key of ["projectId", "docId", "author", "kind"]) {
        const value = options[key] ?? (key === "kind" ? options.type : undefined)
        if (value) { conditions.push(`d.${key} = ?`); parameters.push(String(value)) }
      }
      if (options.tag) {
        conditions.push("EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?)")
        parameters.push(String(options.tag))
      }
      const limit = Math.max(1, Math.min(Number(options.limit) || 50, 100))
      return db.prepare(`SELECT d.*, bm25(document_fts, 5, 2, 3, 1) AS score,
        snippet(document_fts, 3, '', '', ' … ', 40) AS excerpt
        FROM document_fts JOIN documents d ON d.rowid = document_fts.rowid
        WHERE ${conditions.join(" AND ")} ORDER BY score, d.relative LIMIT ?`).all(...parameters, limit).map(publicDocument)
    }),
    close: () => serial(async () => { db?.close(); db = undefined; initialized = false }),
  }
}
