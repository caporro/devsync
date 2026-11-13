import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-tasks-v2-"))
Object.assign(process.env, {
  NODE_ENV: "test",
  AUTH_MODE: "none",
  AUTH_USERS: "",
  DEVSYNC_AUTH_USERS: "",
  DEVSYNC_API_TOKEN: "tasks-test-token",
  DEVSYNC_DATA_ROOT: root,
  DEVSYNC_DATA_DIR: "",
  DEVSYNC_VAULT_NAME: "vault",
  DEVSYNC_WEB_DIST: path.join(root, "web")
})
const storage = await import("./storage.js")
const { app } = await import("./index.js")
const { taskEvents } = await import("./task-events.js")
const { createDevsyncMcpServer } = await import("./mcp-server.js")
const { resolveAgentTools } = await import("./agent-tools.js")
const { createPasswordHash, resolveTaskOwner } = await import("./auth.js")
const events = []
const capture = (event) => {
  events.push(event)
}
taskEvents.on("event", capture)
const headers = { authorization: "Bearer tasks-test-token" }
after(async () => {
  taskEvents.off("event", capture)
  await app.close()
  await fs.rm(root, { recursive: true, force: true })
})

async function fixture(name) {
  await storage.createProject({ name })
  return path.join(storage.dataDir, name, "tasks")
}

function body(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
}

test("migration preserves original bodies, custom metadata, identity, assignments, checkbox state and manual order", async () => {
  const directory = await fixture("legacy")
  const first =
    '---\ntitle: "First"\ncreatedBy: "Original author"\ncreatedAt: "2020-01-01"\nowner: "Old owner"\ncustom:\n  nested: keep me\ntags: ["alpha", "beta"]\n---\n\n# First\n\nOriginal **Markdown**, accents àè, links [file](../resources/source.md).\n\n- [ ] embedded checklist\n\n'
  const second = "# Second\r\n\r\nOriginal CRLF content.\r\n\r\n"
  const index =
    "# Tasks\n\nKeep this free-form note.\n\n- [x] [Second](second.md) — Assigned from index — due 2026-11-20\n- [ ] [First](first.md) — Old owner\n"
  await fs.writeFile(path.join(directory, "first.md"), first)
  await fs.writeFile(path.join(directory, "second.md"), second)
  await fs.writeFile(path.join(directory, "README.md"), index)
  const tasks = await storage.listTasks("legacy")
  assert.deepEqual(
    tasks.map((task) => [task.name, task.status, task.order, task.owner]),
    [
      ["second.md", "done", 0, "Assigned from index"],
      ["first.md", "todo", 1, "Old owner"]
    ]
  )
  const migratedFirst = await storage.readTask("legacy", "tasks/first.md")
  const migratedSecond = await storage.readTask("legacy", "tasks/second.md")
  assert.equal(body(migratedFirst.content), body(first))
  assert.equal(body(migratedSecond.content), second)
  assert.equal(migratedSecond.deadline, "2026-11-20")
  assert.match(migratedFirst.content, /custom:\n  nested: keep me/)
  assert.match(migratedFirst.content, /createdBy: "Original author"/)
  assert.match(migratedFirst.content, /tags: \["alpha", "beta"\]/)
  assert.equal(await fs.readFile(path.join(directory, ".migration-v2", "first.md"), "utf8"), first)
  assert.equal(await fs.readFile(path.join(directory, ".migration-v2", "second.md"), "utf8"), second)
  assert.equal(await fs.readFile(path.join(directory, ".migration-v2", "README.md"), "utf8"), index)
  const revisions = tasks.map((task) => task.revision)
  await storage.ensureTaskIndex("legacy")
  assert.deepEqual(
    (await storage.listTasks("legacy")).map((task) => task.revision),
    revisions
  )
  await fs.unlink(path.join(directory, "README.md"))
  assert.deepEqual(
    (await storage.listTasks("legacy")).map((task) => [task.id, task.status, task.order]),
    tasks.map((task) => [task.id, task.status, task.order])
  )
})

test("reading migrated tasks and project lists does not rescan the entire vault", async () => {
  const directory = await fixture("read-cost")
  const created = await storage.createTask("read-cost", { title: "Read without rescanning", body: "Original body" })
  const reconcile = storage.documentIndex.reconcile
  let scans = 0
  storage.documentIndex.reconcile = () => { scans += 1; return reconcile() }
  try {
    assert.equal((await storage.listTasks("read-cost"))[0].id, created.id)
    const projects = await storage.listProjects()
    assert.ok(projects.some((project) => project.id === "read-cost"))
    assert.ok((await storage.listAllTasks()).some((task) => task.id === created.id))
    await fs.appendFile(path.join(directory, created.name), "\nExternal filesystem edit.\n")
    const edited = await storage.readTask("read-cost", created.path)
    assert.match(edited.content, /External filesystem edit/)
    assert.notEqual(edited.revision, created.revision)
    assert.equal(scans, 0)
  } finally {
    storage.documentIndex.reconcile = reconcile
  }
})

test("migration maps legacy open status using the index checkbox and preserves originals", async () => {
  const directory = await fixture("legacy-open")
  const original = '---\nstatus: "open"\nowner: "Original owner"\n---\n\n# Legacy task\n\nKeep the body.\n'
  await fs.writeFile(path.join(directory, "pending.md"), original)
  await fs.writeFile(path.join(directory, "completed.md"), original)
  await fs.writeFile(path.join(directory, "README.md"), "# Tasks\n\n- [x] [Completed](completed.md)\n- [ ] [Pending](pending.md)\n")
  const tasks = await storage.listTasks("legacy-open")
  assert.deepEqual(tasks.map((task) => [task.name, task.status, task.order]), [
    ["completed.md", "done", 0],
    ["pending.md", "todo", 1]
  ])
  for (const task of tasks) {
    assert.equal(body((await storage.readTask("legacy-open", task.path)).content), body(original))
    assert.equal(await fs.readFile(path.join(directory, ".migration-v2", task.name), "utf8"), original)
  }
  const pending = tasks.find((task) => task.status === "todo")
  await assert.rejects(storage.updateTask("legacy-open", pending.path, { status: "open", expectedRevision: pending.revision }), /Invalid task status/)
})

test("migration supports plan directories and can resume after only some files were migrated", async () => {
  const directory = await fixture("old-plan")
  await fs.rm(directory, { recursive: true })
  const plan = path.join(storage.dataDir, "old-plan", "plan")
  await fs.mkdir(plan)
  await fs.writeFile(path.join(plan, "readme.md"), "# Plan\n\n- [x] [One](one.md)\n- [ ] [Two](two.md)\n")
  await fs.writeFile(path.join(plan, "one.md"), '---\nstatus: "done"\norder: 0\n---\n# One\nOriginal one\n')
  await fs.writeFile(path.join(plan, "two.md"), "# Two\nOriginal two\n")
  assert.deepEqual(
    (await storage.listTasks("old-plan")).map((task) => [task.title, task.status, task.order]),
    [
      ["One", "done", 0],
      ["Two", "todo", 1]
    ]
  )
  assert.equal(body((await storage.readTask("old-plan", "tasks/two.md")).content), "# Two\nOriginal two\n")
})

test("all six states live in the task revision and stale updates, deletes and reorders are rejected", async () => {
  await fixture("states")
  const original = await storage.createTask("states", {
    title: "Stateful",
    owner: "owner@example.com",
    body: "Delivery details"
  })
  assert.equal(original.status, "backlog")
  let task = original
  for (const status of storage.TASK_STATUSES) {
    task = await storage.updateTask("states", task.path, { status, expectedRevision: task.revision, author: "editor" })
    assert.equal(task.status, status)
    assert.match(task.content, new RegExp(`status: "${status}"`))
    assert.equal(task.id, original.id)
  }
  assert.notEqual(task.revision, original.revision)
  await assert.rejects(
    storage.updateTask("states", task.path, { status: "todo", expectedRevision: original.revision }),
    { statusCode: 409 }
  )
  await assert.rejects(storage.deleteTask("states", task.path, { expectedRevision: original.revision }), {
    statusCode: 409
  })
  await assert.rejects(storage.updateTask("states", task.path, { status: "todo" }), { statusCode: 400 })
  await assert.rejects(
    storage.updateTask("states", task.path, { status: "unknown", expectedRevision: task.revision }),
    { statusCode: 400 }
  )
  const concurrent = await Promise.allSettled(
    ["doing", "pause"].map((status) =>
      storage.updateTask("states", task.path, { status, expectedRevision: task.revision })
    )
  )
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(concurrent.find((result) => result.status === "rejected").reason.statusCode, 409)
  assert.ok(events.some((event) => event.type === "task.status_changed" && event.projectId === "states"))
})

test("safe reorder persists order in files, rejects stale snapshots before writes, and cannot change fields through the index", async () => {
  await fixture("ordering")
  await storage.createTask("ordering", { title: "One" })
  await storage.createTask("ordering", { title: "Two", status: "pause" })
  const initial = await storage.listTasks("ordering")
  const changed = await storage.updateTask("ordering", initial[1].path, {
    status: "done",
    expectedRevision: initial[1].revision
  })
  await assert.rejects(
    storage.reorderTasks("ordering", {
      items: initial.map((task) => ({ path: task.path, expectedRevision: task.revision })).reverse()
    }),
    { statusCode: 409 }
  )
  assert.equal((await storage.readTask("ordering", initial[0].path)).revision, initial[0].revision)
  assert.equal((await storage.readTask("ordering", changed.path)).status, "done")
  const current = await storage.listTasks("ordering")
  const reordered = await storage.reorderTasks("ordering", {
    items: current.map((task) => ({ path: task.path, expectedRevision: task.revision })).reverse()
  })
  assert.deepEqual(
    reordered.map((task) => task.title),
    ["Two", "One"]
  )
  await assert.rejects(storage.updateTaskIndex("ordering", { items: initial }), { statusCode: 400 })
  const directory = path.join(storage.dataDir, "ordering", "tasks")
  await fs.unlink(path.join(directory, "README.md"))
  assert.deepEqual(
    (await storage.listTasks("ordering")).map((task) => [task.title, task.status]),
    [
      ["Two", "done"],
      ["One", "backlog"]
    ]
  )
})

test("HTTP, MCP and Assistant use the same mutations, revisions, attribution and task events", async () => {
  await fixture("channels")
  const api = await app.inject({
    method: "POST",
    url: "/api/projects/channels/tasks",
    headers,
    payload: { title: "HTTP", status: "todo", createdBy: "forged" }
  })
  assert.equal(api.statusCode, 201, api.body)
  assert.match(api.json().content, /createdBy: "api-token"/)
  const client = new Client({ name: "tasks-test", version: "1" })
  const server = createDevsyncMcpServer({ user: { email: "mcp@example.com" } })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await server.connect(right)
  await client.connect(left)
  try {
    const result = await client.callTool({
      name: "create_task",
      arguments: { projectId: "channels", title: "MCP", status: "doing" }
    })
    assert.ok(!result.isError)
    const task = JSON.parse(result.content[0].text)
    assert.equal(task.status, "doing")
    assert.match(task.content, /createdBy: "mcp@example.com"/)
    const edited = await client.callTool({
      name: "update_task",
      arguments: { projectId: "channels", path: task.path, status: "pause", expectedRevision: task.revision }
    })
    assert.ok(!edited.isError)
    const stale = await client.callTool({
      name: "update_task",
      arguments: { projectId: "channels", path: task.path, status: "done", expectedRevision: task.revision }
    })
    assert.equal(JSON.parse(stale.content[0].text).statusCode, 409)
  } finally {
    await client.close()
    await server.close()
  }
  const tools = resolveAgentTools(["create_task", "read_task", "update_task", "toggle_task"], {
    projectId: "channels",
    read: ["tasks/**"],
    write: ["tasks/**"],
    actor: "automation:triage",
    source: "automation"
  })
  const byName = (name) => tools.find((tool) => tool.name === name)
  const created = await byName("create_task").invoke({ title: "Assistant", status: "rejected" })
  assert.match(created.content, /createdBy: "automation:triage"/)
  const read = await byName("read_task").invoke({ path: created.path })
  await byName("update_task").invoke({ path: read.path, expectedRevision: read.revision, status: "todo" })
  const added = events.filter((event) => event.projectId === "channels" && event.type === "task.added")
  assert.deepEqual(
    added.map((event) => event.source),
    ["api", "mcp", "automation"]
  )
  const noRead = resolveAgentTools(["read_task"], { projectId: "channels", read: [], write: [] })[0]
  await assert.rejects(noRead.invoke({ path: created.path }), /read permission/)
  const indexOnly = resolveAgentTools(["toggle_task"], {
    projectId: "channels",
    read: ["tasks/**"],
    write: ["tasks/README.md"]
  })[0]
  await assert.rejects(indexOnly.invoke({ path: read.path, expectedRevision: read.revision }), /write permission/)
  const query = `?path=${encodeURIComponent(api.json().path)}`
  const missingRevision = await app.inject({
    method: "PATCH",
    url: `/api/projects/channels/tasks/content${query}`,
    headers,
    payload: { status: "done" }
  })
  assert.equal(missingRevision.statusCode, 400)
  const readApi = await app.inject({ method: "GET", url: `/api/projects/channels/tasks/content${query}`, headers })
  const updatedApi = await app.inject({
    method: "PATCH",
    url: `/api/projects/channels/tasks/content${query}`,
    headers,
    payload: { status: "done", expectedRevision: readApi.json().revision }
  })
  assert.equal(updatedApi.statusCode, 200)
  assert.equal(updatedApi.json().status, "done")
})

test("assignees resolve to email only when unambiguous; unknown and ambiguous legacy assignments survive", async () => {
  const hash = await createPasswordHash("test-password")
  process.env.AUTH_USERS = `ada@example.com|Ada|${hash},one@example.com|Same Name|${hash},two@example.com|Same Name|${hash}`
  try {
    assert.equal(resolveTaskOwner("Ada"), "ada@example.com")
    assert.equal(resolveTaskOwner("ADA@EXAMPLE.COM"), "ada@example.com")
    assert.equal(resolveTaskOwner("Same Name"), "Same Name")
    assert.equal(resolveTaskOwner("Unknown assignee"), "Unknown assignee")
    const directory = await fixture("owners")
    await fs.writeFile(path.join(directory, "legacy.md"), '---\nowner: "Ada"\n---\n# Owner\nDetails\n')
    await fs.writeFile(path.join(directory, "README.md"), "# Tasks\n- [ ] [Owner](legacy.md) — Ada\n")
    assert.equal((await storage.listTasks("owners"))[0].owner, "ada@example.com")
  } finally {
    process.env.AUTH_USERS = ""
  }
})

test("global task API includes every project and keeps identical task paths isolated", async () => {
  const alpha = await fixture("kanban-alpha")
  const beta = await fixture("kanban-beta")
  await fs.writeFile(
    path.join(alpha, "shared.md"),
    '---\nstatus: "doing"\norder: 0\nowner: "other@example.com"\n---\n# Shared title\nAlpha content\n'
  )
  await fs.writeFile(
    path.join(beta, "shared.md"),
    '---\nstatus: "doing"\norder: 0\n---\n# Shared title\nBeta content\n'
  )
  assert.equal((await app.inject({ method: "GET", url: "/api/tasks" })).statusCode, 401)
  const response = await app.inject({ method: "GET", url: "/api/tasks", headers })
  assert.equal(response.statusCode, 200, response.body)
  const tasks = response.json().items.filter((task) => task.projectId.startsWith("kanban-"))
  assert.deepEqual(
    tasks.map((task) => [task.projectId, task.projectName, task.path, task.status]),
    [
      ["kanban-alpha", "kanban alpha", "tasks/shared.md", "doing"],
      ["kanban-beta", "kanban beta", "tasks/shared.md", "doing"]
    ]
  )
  assert.notEqual(tasks[0].id, tasks[1].id)
  assert.ok(tasks.every((task) => task.revision && !("content" in task)))
  assert.equal(tasks[1].owner, "")
  const updated = await app.inject({
    method: "PATCH",
    url: `/api/projects/${tasks[1].projectId}/tasks/content?path=${encodeURIComponent(tasks[1].path)}`,
    headers,
    payload: { status: "done", expectedRevision: tasks[1].revision }
  })
  assert.equal(updated.statusCode, 200, updated.body)
  const unchanged = await storage.readTask(tasks[0].projectId, tasks[0].path)
  assert.equal(unchanged.status, "doing")
  assert.equal(unchanged.revision, tasks[0].revision)
  const reload = await app.inject({ method: "GET", url: "/api/tasks", headers })
  assert.equal(reload.json().items.find((task) => task.projectId === "kanban-beta").status, "done")
  await fs.writeFile(path.join(alpha, "shared.md"), unchanged.content.replace('status: "doing"', 'status: "invalid"'))
  const invalid = await app.inject({ method: "GET", url: "/api/tasks", headers })
  assert.equal(invalid.statusCode, 400, "Unreadable projects must not silently disappear from the global board")
  await fs.writeFile(path.join(alpha, "shared.md"), unchanged.content)
})

test("migration rejects invalid metadata before touching other task files", async () => {
  const directory = await fixture("invalid")
  const first = "# Good\nContent to preserve\n"
  const invalid = '---\nstatus: "mystery"\n---\n# Invalid\nDo not discard this state\n'
  const index = "# Tasks\n\n- [x] [Good](good.md)\n- [ ] [Invalid](invalid.md)\n"
  await fs.writeFile(path.join(directory, "good.md"), first)
  await fs.writeFile(path.join(directory, "invalid.md"), invalid)
  await fs.writeFile(path.join(directory, "README.md"), index)
  await assert.rejects(storage.listTasks("invalid"), { statusCode: 400 })
  assert.equal(await fs.readFile(path.join(directory, "good.md"), "utf8"), first)
  assert.equal(await fs.readFile(path.join(directory, "invalid.md"), "utf8"), invalid)
  assert.equal(await fs.readFile(path.join(directory, "README.md"), "utf8"), index)
})

test("migration understands escaped Markdown labels and retains checked state", async () => {
  const directory = await fixture("escaped")
  await fs.writeFile(path.join(directory, "task.md"), "# Fix [error]\nDetails\n")
  await fs.writeFile(path.join(directory, "README.md"), "# Tasks\n\n- [x] [Fix [error\\]](task.md) — Existing owner\n")
  const [task] = await storage.listTasks("escaped")
  assert.equal(task.status, "done")
  assert.equal(task.owner, "Existing owner")
})

test("the migration command uses the configured filesystem vault and preserves source backups", async () => {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const directory = path.join(root, "cli-vault", "projects", "demo", "tasks")
  await fs.mkdir(directory, { recursive: true })
  const original = "# CLI task\nOriginal CLI body\n"
  await fs.writeFile(path.join(directory, "task.md"), original)
  await fs.writeFile(path.join(directory, "README.md"), "# Tasks\n\n- [x] [CLI task](task.md) — Keep owner\n")
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/migrate-tasks.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, DEVSYNC_VAULT_NAME: "cli-vault" }
  })
  assert.match(stdout, /Verified 1 task/)
  const migrated = await fs.readFile(path.join(directory, "task.md"), "utf8")
  assert.match(migrated, /status: "done"/)
  assert.match(migrated, /owner: "Keep owner"/)
  assert.equal(body(migrated), original)
  assert.equal(await fs.readFile(path.join(directory, ".migration-v2", "task.md"), "utf8"), original)
})

test("Markdown edits retain task metadata, immutable authorship and unknown frontmatter; deletion requires the latest revision", async () => {
  const directory = await fixture("editing")
  await fs.writeFile(path.join(directory, "task.md"), '---\ntitle: "Edit me"\ncreatedBy: "original@example.com"\nowner: "assignee@example.com"\ndeadline: "2026-12-01"\ncustom:\n  nested: retain this\n---\n# Edit me\nOriginal\n')
  await fs.writeFile(path.join(directory, "README.md"), "# Tasks\n\n- [x] [Edit me](task.md)\n")
  const original = await storage.readTask("editing", "tasks/task.md")
  const plain = await storage.updateTask("editing", original.path, { content: "# New title\n\nNew body\n", expectedRevision: original.revision })
  assert.equal(plain.title, "New title")
  assert.equal(plain.status, "done")
  assert.equal(plain.owner, original.owner)
  assert.equal(plain.deadline, original.deadline)
  assert.match(plain.content, /custom:\n  nested: retain this/)
  const edited = await storage.updateTask("editing", plain.path, { content: plain.content.replace('status: "done"', 'status: "pause"').replace(/createdBy: .*/, 'createdBy: "forged"'), expectedRevision: plain.revision, author: "editor@example.com" })
  assert.equal(edited.id, original.id)
  assert.equal(edited.status, "pause")
  assert.match(edited.content, /createdBy: "original@example.com"/)
  assert.match(edited.content, /lastEditor: "editor@example.com"/)
  const document = await storage.updateDocument({ projectId: "editing", path: edited.path, expectedRevision: edited.revision, content: "# New title\n\nDocument edit\n", author: "document-editor" })
  const current = await storage.readTask("editing", edited.path)
  assert.equal(current.status, "pause")
  assert.equal(current.order, original.order)
  assert.match(current.content, /custom:\n  nested: retain this/)
  assert.equal(document.id, original.id)
  await assert.rejects(storage.deleteTask("editing", current.path, { expectedRevision: edited.revision }), { statusCode: 409 })
  await storage.deleteTask("editing", current.path, { expectedRevision: current.revision })
  assert.deepEqual(await storage.listTasks("editing"), [])
})
