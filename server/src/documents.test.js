import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-documents-"))
process.env.NODE_ENV = "test"
process.env.DEVSYNC_DATA_ROOT = root
process.env.DEVSYNC_VAULT_NAME = "documents-vault"
process.env.DEVSYNC_WEB_DIST = path.join(root, "web")
process.env.AUTH_MODE = "none"
process.env.DEVSYNC_API_TOKEN = "document-api-token"
await fs.mkdir(process.env.DEVSYNC_WEB_DIST)
await fs.writeFile(path.join(process.env.DEVSYNC_WEB_DIST, "index.html"), "<!doctype html><html></html>")

const storage = await import("./storage.js")
const { app } = await import("./index.js")
const { createDevsyncMcpServer } = await import("./mcp-server.js")
const { createDocumentIndex } = await import("./document-index.js")
const { createMcpTokenForUser } = await import("./mcp-tokens.js")
const headers = { authorization: "Bearer document-api-token" }
await storage.createProject({ name: "alpha" })
await storage.createProject({ name: "beta" })
after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }) })

test("FTS5 searches all words, normalizes accents, ranks titles, and filters metadata", async () => {
  const strong = await storage.createDocument({ projectId: "alpha", title: "Aurora login", content: "disponibilità del servizio", tags: ["bug", "auth", "one,two"], author: "ada@example.com" })
  await storage.createDocument({ projectId: "alpha", title: "Appunti", content: "Il login di Aurora richiede un token.", author: "bea@example.com" })
  await storage.createDocument({ projectId: "beta", title: "Aurora", content: "Il servizio è disponibile." })
  assert.match(strong.id, /^[0-9a-z]{5}$/)
  const results = await storage.searchFiles({ query: "aurora LOGIN", type: "resources" })
  assert.equal(results.length, 2)
  assert.equal(results[0].id, strong.id)
  assert.ok(results.every((item) => item.excerpt && item.url && item.revision))
  assert.equal((await storage.searchFiles({ query: "disponibilita", projectId: "alpha", tag: "bug", author: "ada@example.com", type: "resources" }))[0].id, strong.id)
  assert.equal((await storage.searchFiles({ query: "disponibilita", tag: "one,two" }))[0].id, strong.id)
  assert.equal((await storage.searchFiles({ query: "aurora login", projectId: "beta" })).length, 0)
  assert.deepEqual(await storage.searchFiles({ query: "***" }), [])
  assert.equal((await storage.searchFiles({ query: 'aurora" OR login' })).length, 0)
})

test("documents resolve by ID/URL/URI, preserve identity and creator, and reject stale concurrent updates", async () => {
  const original = await storage.createDocument({ docId: "team", folder: "incidents", title: "Atlas", content: "Original analysis", tags: ["incident"], author: "ada@example.com" })
  for (const ref of [original.id, original.url, `https://devsync.example${original.url}`, original.ref]) {
    assert.equal((await storage.readDocument({ ref })).id, original.id)
  }
  const changes = await Promise.allSettled(["first", "second"].map((body) => storage.updateDocument({ ref: original.id, expectedRevision: original.revision, content: `---\nid: zzzzz\ncreator: forged\n---\n# Atlas\n${body}`, author: "bea@example.com" })))
  assert.equal(changes.filter((item) => item.status === "fulfilled").length, 1)
  assert.equal(changes.find((item) => item.status === "rejected").reason.statusCode, 409)
  const updated = await storage.readDocument({ ref: original.id })
  assert.match(updated.content, /creator: "ada@example.com"/)
  assert.match(updated.content, /lastEditor: "bea@example.com"/)
  assert.equal(updated.id, original.id)
  assert.deepEqual(updated.tags, ["incident"])
  const oldPath = path.join(storage.docsDir, "team", original.path)
  const newPath = path.join(storage.docsDir, "team", "renamed.md")
  await fs.rename(oldPath, newPath)
  assert.equal((await storage.readDocument({ ref: original.id })).path, "renamed.md")
})

test("concurrent publication of the same title creates distinct files and IDs", async () => {
  const published = await Promise.all(Array.from({ length: 4 }, (_, index) => storage.createDocument({ projectId: "alpha", title: "Concurrent title", content: `Independent body ${index}` })))
  assert.equal(new Set(published.map((document) => document.id)).size, 4)
  assert.equal(new Set(published.map((document) => document.path)).size, 4)
  for (const [index, document] of published.entries()) {
    assert.match((await storage.readDocument({ ref: document.id })).content, new RegExp(`Independent body ${index}`))
  }
})

test("application moves and project renames keep shared links intact", async () => {
  const project = await storage.createProject({ name: "rename-source" })
  const original = await storage.createDocument({ projectId: project.id, title: "Move proof", content: "Durable reference" })
  await storage.createProjectFolder(project.id, "resources", { folder: "nested" })
  await storage.moveProjectEntry(project.id, { from: original.path, to: "resources/nested/moved.md", author: "ada@example.com" })
  assert.equal((await storage.readDocument({ ref: original.id })).path, "resources/nested/moved.md")
  const renamed = await storage.updateProject(project.id, { name: "rename-destination" })
  const resolved = await storage.readDocument({ ref: original.url })
  assert.equal(resolved.projectId, renamed.id)
  assert.equal(resolved.id, original.id)
})

test("legacy files, external edits, deletions and rebuilding the SQLite cache follow the filesystem", async () => {
  const file = path.join(storage.dataDir, "alpha", "work", "legacy.md")
  await fs.writeFile(file, "---\ncustom:\n  nested: preserved\n---\n# Cometa\nLegacy body\n")
  const legacy = await storage.readDocument({ projectId: "alpha", path: "work/legacy.md" })
  assert.match(legacy.content, /custom:\n  nested: preserved/)
  await storage.documentIndex.close()
  for (const suffix of ["", "-wal", "-shm"]) await fs.rm(path.join(storage.vaultDir, ".devsync", `search.sqlite${suffix}`), { force: true })
  const rebuilt = await storage.readDocument({ ref: legacy.id })
  assert.equal(rebuilt.id, legacy.id)
  await fs.writeFile(file, rebuilt.content.replace("Legacy body", "External nebulosa update"))
  await storage.documentIndex.reconcile()
  assert.equal((await storage.searchFiles({ query: "nebulosa" }))[0].id, legacy.id)
  await fs.unlink(file)
  await storage.documentIndex.reconcile()
  assert.equal((await storage.searchFiles({ query: "nebulosa" })).length, 0)
  await assert.rejects(storage.readDocument({ ref: legacy.id }), { statusCode: 404 })
})

test("duplicate IDs and symlink escapes are explicit errors, without changing document identity", async () => {
  const original = await storage.createDocument({ projectId: "beta", title: "Duplicate", content: "Duplicate check" })
  const copy = path.join(storage.dataDir, "beta", "resources", "copy.md")
  await fs.writeFile(copy, original.content)
  await assert.rejects(storage.documentIndex.reconcile(), { statusCode: 409 })
  assert.equal(await fs.readFile(copy, "utf8"), original.content)
  await fs.unlink(copy)
  const external = path.join(root, "external.md")
  await fs.writeFile(external, "Private external text")
  const link = path.join(storage.dataDir, "beta", "resources", "symlink.md")
  await fs.symlink(external, link)
  await assert.rejects(storage.readDocument({ projectId: "beta", path: "resources/symlink.md" }), { statusCode: 400 })
  assert.equal((await storage.searchFiles({ query: "Private external" })).length, 0)
  await fs.unlink(link)
  const isolated = path.join(root, "isolated")
  await fs.mkdir(isolated)
  await fs.symlink(root, path.join(isolated, ".devsync"))
  const index = createDocumentIndex({ vaultDir: isolated, projectsDir: path.join(isolated, "projects"), docsDir: path.join(isolated, "docs") })
  await assert.rejects(index.reconcile(), { statusCode: 400 })
  await index.close()
})

test("HTTP auth is enforced and document/task authors cannot be forged", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/search?query=login" })).statusCode, 401)
  const response = await app.inject({ method: "POST", url: "/api/documents", headers, payload: { projectId: "alpha", title: "HTTP proof", content: "# Proof\nBody", author: "forged", creator: "forged" } })
  assert.equal(response.statusCode, 201, response.body)
  const created = response.json()
  assert.equal(created.author, "api-token")
  const task = await app.inject({ method: "POST", url: "/api/projects/alpha/tasks", headers, payload: { title: "Authenticated task", createdBy: "forged" } })
  assert.equal(task.statusCode, 201)
  const read = await storage.readDocument({ projectId: "alpha", path: task.json().path })
  assert.match(read.content, /createdBy: "api-token"/)
  const update = await app.inject({ method: "PATCH", url: "/api/documents", headers, payload: { ref: created.id, expectedRevision: created.revision, content: "# Updated\nNew body", author: "forged" } })
  assert.equal(update.statusCode, 200, update.body)
  assert.match(update.json().content, /lastEditor: "api-token"/)
  assert.equal((await app.inject({ method: "GET", url: `/api/documents?ref=${created.id}`, headers })).json().id, created.id)
})

test("metadata and tags survive edits; external changes with preserved mtime are reindexed", async () => {
  const file = path.join(storage.dataDir, "alpha", "work", "yaml.md")
  await fs.writeFile(file, "---\ncustom:\n  nested: keep me\n---\n# Metadata\nOldword\n")
  const old = await storage.readDocument({ projectId: "alpha", path: "work/yaml.md" })
  const updated = await storage.updateDocument({ ref: old.id, expectedRevision: old.revision, content: "# Metadata\nNewword\n", tags: ["one", "two"], author: "ada@example.com" })
  assert.match(updated.content, /custom:\n  nested: keep me/)
  assert.deepEqual(updated.tags, ["one", "two"])
  const stat = await fs.stat(file)
  await fs.writeFile(file, updated.content.replace("Newword", "Nextone"))
  await fs.utimes(file, stat.atime, stat.mtime)
  await storage.documentIndex.reconcile()
  assert.equal((await storage.searchFiles({ query: "Nextone", tag: "two" }))[0].id, old.id)
  await fs.writeFile(file, "# Metadata\nBody replaced without frontmatter\n")
  await storage.documentIndex.reconcile()
  assert.equal((await storage.readDocument({ ref: old.id })).id, old.id)
  await storage.documentIndex.rebuild()
  assert.equal((await storage.readDocument({ ref: old.id })).id, old.id)
})

test("MCP removes aliases, publishes documents and attributes writes to the selected token owner", async () => {
  const server = createDevsyncMcpServer({ user: { email: "token-owner@example.com" }, baseUrl: "https://devsync.example" })
  const client = new Client({ name: "test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const { tools } = await client.listTools()
    assert.equal(tools.some((item) => /plan_item/.test(item.name)), false)
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args })
      assert.ok(!result.isError, JSON.stringify(result))
      return JSON.parse(result.content[0].text)
    }
    const doc = await call("create_document", { docId: "team", title: "MCP delivery", content: "MCP publication", author: "forged" })
    assert.equal(doc.author, "token-owner@example.com")
    assert.equal(doc.url, `https://devsync.example/d/${doc.id}`)
    assert.equal((await call("read_file", { ref: doc.url })).id, doc.id)
    assert.equal((await call("read_file", { docId: "team", path: doc.path })).id, doc.id)
    const edited = await call("update_document", { ref: doc.ref, expectedRevision: doc.revision, content: "MCP publication edited", tags: ["delivery"] })
    assert.match(edited.content, /lastEditor: "token-owner@example.com"/)
    assert.deepEqual(edited.tags, ["delivery"])
    const stale = await client.callTool({ name: "update_document", arguments: { ref: doc.id, expectedRevision: doc.revision, content: "Obsolete content" } })
    assert.equal(stale.isError, true)
    assert.equal(JSON.parse(stale.content[0].text).statusCode, 409)
    const task = await call("create_task", { projectId: "alpha", title: "Token task", createdBy: "forged" })
    assert.match(task.content, /createdBy: "token-owner@example.com"/)
    assert.equal((await call("search_files", { query: "MCP publication" }))[0].id, doc.id)
  } finally { await client.close(); await server.close() }
})

test("HTTP MCP uses the personal bearer token identity rather than client parameters", async () => {
  const { token } = await createMcpTokenForUser({ email: "personal@example.com", name: "Personal User" })
  const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, payload: {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_document", arguments: { projectId: "alpha", title: "Personal identity", content: "Personal token evidence", author: "forged" } },
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.match(response.body, /personal@example.com/)
  assert.doesNotMatch(response.body, /creator.*forged/)
})
