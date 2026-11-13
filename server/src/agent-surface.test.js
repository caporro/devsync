import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { after, test } from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-agent-surface-"))
Object.assign(process.env, {
  NODE_ENV: "test", AUTH_MODE: "none", AUTH_USERS: "", DEVSYNC_AUTH_USERS: "",
  DEVSYNC_API_TOKEN: "surface-token", DEVSYNC_DATA_ROOT: root, DEVSYNC_DATA_DIR: "",
  DEVSYNC_VAULT_NAME: "vault", DEVSYNC_WEB_DIST: path.join(root, "web"),
  DEVSYNC_ACTIVITY_LOG_ENTRIES_PER_FILE: "3"
})
const storage = await import("./storage.js")
const { app } = await import("./index.js")
const { createDevsyncMcpServer } = await import("./mcp-server.js")
const headers = { authorization: "Bearer surface-token" }
after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }) })

async function project(name) {
  await storage.createProject({ name })
  return path.join(storage.dataDir, name, "tasks")
}

async function mcp() {
  const server = createDevsyncMcpServer({ user: { email: "agent@example.com" } })
  const client = new Client({ name: "surface-test", version: "1" })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await server.connect(right)
  await client.connect(left)
  return { client, close: async () => { await client.close(); await server.close() } }
}

function legacyTask(title, id) {
  return `---\nid: "${id}"\ntitle: "${title}"\ncreatedAt: "2026-07-02T10:00:00.000Z"\ncreatedBy: "original@example.com"\ncustom: "keep"\n---\n\n# ${title}\n\nOriginal **body**.\n`
}

const prefix = "2026-07-02T10-00-00.000Z-"
const longStem = `${prefix}${"x".repeat(137 - prefix.length)}`

test("long titles and colliding uploads preserve their extension and remain usable", async () => {
  await project("long-names")
  const title = `[CCD 2026-07-02] ${"Long title ".repeat(30)}`
  const task = await storage.createTask("long-names", { title, body: "Details" })
  assert.equal(path.extname(task.name), ".md")
  assert.ok(task.name.length <= 140)
  assert.equal(task.title, title.trim())
  await storage.toggleTask("long-names", task.path, true, { expectedRevision: task.revision })
  assert.equal((await storage.listTasks("long-names"))[0].status, "done")
  const uploads = []
  for (let index = 0; index < 2; index++) {
    uploads.push(await storage.saveUpload("long-names", {
      filename: `${"a".repeat(180)}.md`, file: Readable.from([`# Upload ${index}\n`])
    }))
  }
  assert.notEqual(uploads[0].path, uploads[1].path)
  assert.ok(uploads.every((file) => file.name.length <= 140 && file.name.endsWith(".md")))
  const drawing = await storage.addExcalidrawArtifact("long-names", { title, content: "" })
  assert.ok(path.basename(drawing.path).length <= 140)
  assert.equal(path.extname(drawing.path), ".excalidraw")
})

test("filename repair previews without writes, handles collisions, and preserves task identity and checked state", async () => {
  const directory = await project("repair")
  const names = [`${longStem}aaa`, `${longStem}bbb`]
  const originals = [legacyTask("[CCD] First", "old01"), legacyTask("Second", "old02")]
  for (let index = 0; index < names.length; index++) await fs.writeFile(path.join(directory, names[index]), originals[index])
  const existing = `${longStem}.md`
  const existingBody = legacyTask("Existing destination", "exist")
  await fs.writeFile(path.join(directory, existing), existingBody)
  const index = `# Tasks\n\n- [x] [[CCD\\] First](${names[0]}) — Alice — due 2026-07-03\n- [ ] [Second](${names[1]}) — Bob\n- [ ] [Existing](${existing})\n`
  await fs.writeFile(path.join(directory, "README.md"), index)
  const preview = await storage.repairTaskFileNames("repair")
  assert.equal(preview.repairs.length, 2)
  assert.equal(new Set(preview.repairs.map((item) => item.to)).size, 2)
  assert.equal(await fs.readFile(path.join(directory, "README.md"), "utf8"), index)
  await assert.rejects(fs.access(path.join(directory, ".filename-repair")), { code: "ENOENT" })
  const result = await storage.repairTaskFileNames("repair", { dryRun: false })
  assert.deepEqual(result, preview)
  assert.equal(await fs.readFile(path.join(directory, ".filename-repair", "README.md"), "utf8"), index)
  for (let i = 0; i < names.length; i++) {
    assert.equal(await fs.readFile(path.join(directory, ".filename-repair", names[i]), "utf8"), originals[i])
    await assert.rejects(fs.access(path.join(directory, names[i])), { code: "ENOENT" })
  }
  const tasks = await storage.listTasks("repair")
  assert.deepEqual(tasks.map((task) => [task.id, task.status, task.owner]), [
    ["old01", "done", "Alice"], ["old02", "todo", "Bob"], ["exist", "todo", ""]
  ])
  const first = await storage.readTask("repair", result.repairs[0].to)
  assert.equal(first.deadline, "2026-07-03")
  assert.match(first.content, /custom: "keep"/)
  assert.match(first.content, /Original \*\*body\*\*\./)
  assert.equal(first.createdBy, "original@example.com")
  assert.equal((await storage.readDocument({ ref: first.id })).path, first.path)
  assert.deepEqual(await storage.repairTaskFileNames("repair", { dryRun: false }), { repairs: [], skipped: [] })
})

test("repair resumes a linked-but-not-unlinked file and reports binary candidates without changing them", async () => {
  const directory = await project("repair-retry")
  const broken = `${longStem}a.m`
  const fixed = `${longStem}a`.slice(0, 137) + ".md"
  const original = legacyTask("Interrupted", "retry")
  await fs.writeFile(path.join(directory, broken), original)
  await fs.link(path.join(directory, broken), path.join(directory, fixed))
  await fs.writeFile(path.join(directory, "README.md"), `# Tasks\n\n- [x] [Interrupted](${fixed}) — Owner\n`)
  const binaryName = `${longStem}bin`
  const binary = Buffer.from([0, 255, 123])
  await fs.writeFile(path.join(directory, binaryName), binary)
  const result = await storage.repairTaskFileNames("repair-retry", { dryRun: false })
  assert.deepEqual(result.repairs, [{ from: `tasks/${broken}`, to: `tasks/${fixed}` }])
  assert.equal(result.skipped[0].path, `tasks/${binaryName}`)
  assert.deepEqual(await fs.readFile(path.join(directory, binaryName)), binary)
  assert.equal((await storage.listTasks("repair-retry"))[0].status, "done")
  assert.equal((await storage.listTasks("repair-retry")).length, 1)
})

test("the maintenance CLI previews separately and explicitly repairs before migrating", async () => {
  const directory = path.join(root, "cli", "projects", "demo", "tasks")
  await fs.mkdir(directory, { recursive: true })
  const broken = `${longStem}cli`
  const original = legacyTask("CLI recovery", "cli01")
  await fs.writeFile(path.join(directory, broken), original)
  await fs.writeFile(path.join(directory, "README.md"), `# Tasks\n\n- [x] [CLI](${broken})\n`)
  const options = { env: { ...process.env, DEVSYNC_VAULT_NAME: "cli" } }
  const run = promisify(execFile)
  const preview = await run(process.execPath, ["scripts/migrate-tasks.mjs", "--repair-filenames", "--dry-run"], options)
  assert.match(preview.stdout, /Would repair 1 task filename/)
  assert.equal(await fs.readFile(path.join(directory, broken), "utf8"), original)
  await assert.rejects(fs.access(path.join(directory, ".filename-repair")), { code: "ENOENT" })
  const applied = await run(process.execPath, ["scripts/migrate-tasks.mjs", "--repair-filenames"], options)
  assert.match(applied.stdout, /Verified 1 task/)
  const fixed = (await fs.readdir(directory)).find((name) => name.endsWith(".md") && name !== "README.md")
  assert.match(await fs.readFile(path.join(directory, fixed), "utf8"), /status: "done"/)
})

test("repair recovers completion from the migration backup after a generated index omitted the broken task", async () => {
  const directory = await project("repair-after-migration")
  const broken = `${longStem}old`
  const fixed = `${longStem}.md`
  const original = legacyTask("Already omitted", "reco1")
  await fs.writeFile(path.join(directory, broken), original)
  await fs.writeFile(path.join(directory, "README.md"), `# Tasks\n\n- [x] [Omitted](${broken}) — Assigned — due 2026-07-03\n`)
  assert.deepEqual(await storage.listTasks("repair-after-migration"), [])
  // Simulate an interrupted repair that has linked the new filename already.
  await fs.link(path.join(directory, broken), path.join(directory, fixed))
  await storage.repairTaskFileNames("repair-after-migration", { dryRun: false })
  const [task] = await storage.listTasks("repair-after-migration")
  assert.equal(task.status, "done")
  assert.equal(task.owner, "Assigned")
  assert.equal(task.deadline, "2026-07-03")
  assert.equal(task.id, "reco1")
  assert.equal(await fs.readFile(path.join(directory, ".filename-repair", broken), "utf8"), original)
})

test("task filters, compact responses and query-bound pagination agree across storage, REST and MCP", async () => {
  const directory = await project("queries")
  const today = new Date().toISOString().slice(0, 10)
  const definitions = [
    ["Active", "doing", "Alice", "2000-01-01", "creator-a"],
    ["Completed", "done", "Alice", "2000-01-01", "creator-a"],
    ["Future", "todo", "Bob", "2999-01-01", "creator-b"],
    ["Rejected", "rejected", "Bob", "2000-01-01", "creator-b"],
    ["Today", "todo", "Alice", today, "creator-a"]
  ]
  const tasks = []
  for (const [title, status, owner, deadline, createdBy] of definitions) {
    tasks.push(await storage.createTask("queries", { title, status, owner, deadline, createdBy, body: "Task body" }))
  }
  const edited = await storage.updateTask("queries", tasks[0].path, { body: "Edited", expectedRevision: tasks[0].revision, author: "editor" })
  await fs.utimes(path.join(directory, tasks[0].name), new Date("2100-01-01"), new Date("2100-01-01"))
  const list = await storage.listTasks("queries")
  assert.ok(Array.isArray(list))
  assert.ok(list.every((task) => !("content" in task)))
  assert.equal(list[0].createdBy, "creator-a")
  assert.equal(list[0].updatedBy, "editor")
  assert.equal(list[1].updatedBy, "creator-a")
  assert.equal((await storage.readTask("queries", edited.path)).updatedBy, "editor")
  assert.deepEqual((await storage.listTasks("queries", { overdue: true })).map((task) => task.title), ["Active"])
  assert.equal((await storage.listTasks("queries", { overdue: false })).length, 4)
  assert.equal((await storage.listTasks("queries", { done: true }))[0].title, "Completed")
  assert.equal((await storage.listTasks("queries", { updatedSince: "2099-01-01T00:00:00Z" }))[0].title, "Active")
  assert.equal((await storage.listTasks("queries", { status: "rejected", owner: "Bob", createdBy: "creator-b" })).length, 1)
  assert.equal((await storage.listTasks("queries", { compact: false }))[0].content, edited.content)
  const seen = []
  let cursor
  do {
    const page = await storage.listTasks("queries", { limit: 2, ...(cursor ? { cursor } : {}) })
    seen.push(...page.items.map((task) => task.id))
    cursor = page.nextCursor
  } while (cursor)
  assert.deepEqual(seen, list.map((task) => task.id))
  const filters = { done: false, owner: "Alice", createdBy: "creator-a", limit: 1 }
  const expected = await storage.listTasks("queries", filters)
  const http = await app.inject({ method: "GET", url: `/api/projects/queries/tasks?${new URLSearchParams(filters)}`, headers })
  assert.equal(http.statusCode, 200, http.body)
  assert.deepEqual(http.json(), expected)
  const connection = await mcp()
  try {
    const response = await connection.client.callTool({ name: "list_tasks", arguments: { projectId: "queries", ...filters } })
    assert.ok(!response.isError)
    assert.deepEqual(JSON.parse(response.content[0].text), expected)
  } finally { await connection.close() }
  const next = await storage.listTasks("queries", { ...filters, cursor: expected.nextCursor })
  assert.equal(next.items[0].title, "Today")
  assert.equal(next.nextCursor, null)
  await assert.rejects(storage.listTasks("queries", { ...filters, cursor: expected.nextCursor, owner: "Bob" }), { statusCode: 409 })
  await storage.updateTask("queries", edited.path, { status: "pause", expectedRevision: edited.revision })
  await assert.rejects(storage.listTasks("queries", { ...filters, cursor: expected.nextCursor }), { statusCode: 409 })
  for (const query of ["cursor=bad", "limit=0", "limit=101", "done=perhaps", "compact=0", "updatedSince=yesterday", "status=unknown"]) {
    const invalid = await app.inject({ method: "GET", url: `/api/projects/queries/tasks?${query}`, headers })
    assert.equal(invalid.statusCode, 400, `${query}: ${invalid.body}`)
  }
})

test("MCP activity writes use token identity, archive long text and retain concurrent entries across rotation", async () => {
  await project("logs")
  const connection = await mcp()
  async function append(content) {
    const result = await connection.client.callTool({ name: "append_log", arguments: { projectId: "logs", content, author: "forged" } })
    assert.ok(!result.isError, JSON.stringify(result))
    return JSON.parse(result.content[0].text)
  }
  try {
    const first = await append("First update")
    assert.equal(first.author, "agent@example.com")
    const batch = await Promise.all(Array.from({ length: 4 }, (_, index) => append(`Concurrent update ${index}`)))
    assert.equal(new Set(batch.map((entry) => entry.id)).size, 4)
    const longText = `${"Long title ".repeat(30)}\n\n${"Detailed diary. ".repeat(80)}`
    const long = await append(longText)
    assert.equal(long.kind, "artifact")
    assert.ok(long.artifactPath.endsWith(".md"))
    assert.ok(path.basename(long.artifactPath).length <= 140)
    const resource = await storage.readProjectFile("logs", long.artifactPath)
    assert.ok(resource.content.includes(longText.trim()))
    const activity = await storage.getActivityLog("logs", { files: 100 })
    assert.equal(activity.entries.length, 6)
    assert.equal(new Set(activity.entries.map((entry) => entry.id)).size, 6)
    assert.equal(activity.files.length, 2)
    assert.equal(activity.entries[0].content, "First update")
    assert.ok(activity.entries.every((entry) => entry.author === "agent@example.com"))
    const audit = (await fs.readFile(path.join(root, "system", "events.ndjson"), "utf8")).trim().split("\n").map(JSON.parse)
    assert.equal(audit.filter((event) => event.action === "activity_log.appended" && event.projectId === "logs" && event.actor === "agent@example.com" && event.source === "mcp").length, 6)
    const blank = await connection.client.callTool({ name: "append_log", arguments: { projectId: "logs", content: "   " } })
    assert.ok(blank.isError)
  } finally { await connection.close() }
})
