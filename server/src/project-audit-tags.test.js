import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-project-audit-tags-"))
Object.assign(process.env, {
  NODE_ENV: "test", AUTH_MODE: "none", AUTH_USERS: "", DEVSYNC_AUTH_USERS: "",
  DEVSYNC_API_TOKEN: "project-audit-tags-test", DEVSYNC_DATA_ROOT: root, DEVSYNC_DATA_DIR: "",
  DEVSYNC_VAULT_NAME: "vault", DEVSYNC_WEB_DIST: path.join(root, "web")
})
const storage = await import("./storage.js")
const { app } = await import("./index.js")
const { createDevsyncMcpServer } = await import("./mcp-server.js")
const { appendSystemLogEvent, listSystemLogEvents } = await import("./system-log.js")
const { resolveAgentTools } = await import("./agent-tools.js")
const server = createDevsyncMcpServer({ user: { email: "marco@example.com" } })
const client = new Client({ name: "project-audit-tags-test", version: "1" })
const [left, right] = InMemoryTransport.createLinkedPair()
await server.connect(right)
await client.connect(left)
const headers = { authorization: "Bearer project-audit-tags-test" }
after(async () => { await client.close(); await server.close(); await app.close(); await fs.rm(root, { recursive: true, force: true }) })

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args })
  assert.ok(!response.isError, JSON.stringify(response))
  return JSON.parse(response.content[0].text)
}

test("MCP creates complete filesystem projects and records operational and authenticated authors", async () => {
  const project = await call("create_project", {
    name: "Agent Hub", slug: "agent-hub", tags: ["shared", "agents"], owner: "Marco", agentName: "Coordinator"
  })
  assert.equal(project.id, "agent-hub")
  assert.deepEqual(project.tags, ["shared", "agents"])
  assert.equal(project.owner, "Marco")
  assert.equal(project.status, "active")
  for (const name of ["README.md", "project.json", "tasks/README.md", "resources", "work", "logs"]) {
    await fs.access(path.join(storage.dataDir, project.id, name))
  }
  assert.equal((await call("get_project", { projectId: project.id })).id, project.id)
  assert.ok((await call("list_projects", {})).some((item) => item.id === project.id))
  const event = (await listSystemLogEvents({ actor: "Coordinator", authenticatedBy: "marco@example.com" })).items[0]
  assert.equal(event.action, "project.created")
  assert.equal(event.projectId, project.id)
  const original = await fs.readFile(path.join(storage.dataDir, project.id, "project.json"), "utf8")
  const duplicate = await client.callTool({ name: "create_project", arguments: { name: "Different", slug: project.id, owner: "Changed" } })
  assert.ok(duplicate.isError)
  assert.equal(JSON.parse(duplicate.content[0].text).statusCode, 409)
  assert.equal(await fs.readFile(path.join(storage.dataDir, project.id, "project.json"), "utf8"), original)
  const automatic = await call("create_project", { name: "New MCP Project" })
  assert.equal(automatic.id, "new-mcp-project")
  assert.equal((await listSystemLogEvents({ action: "project.created" })).items.find((item) => item.projectId === automatic.id).actor, "marco@example.com")
})

test("concurrent project creation reserves the folder once without replacing metadata", async () => {
  const results = await Promise.allSettled(["First", "Second"].map((owner) => storage.createProject({ name: "Concurrent", owner })))
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1)
  assert.equal(results.find((item) => item.status === "rejected").reason.statusCode, 409)
  const winner = results.find((item) => item.status === "fulfilled").value
  assert.equal((await storage.getProject("concurrent")).owner, winner.owner)
})

test("audit actor/user filters combine before limiting, and REST/MCP agree including legacy events", async () => {
  const action = "audit-filter.fixture"
  const expected = await appendSystemLogEvent({ action, actor: "Custode", authenticatedBy: "marco@example.com", summary: "Old matching record", metadata: { fixture: true } })
  await appendSystemLogEvent({ action, actor: "Custode", authenticatedBy: "other@example.com" })
  await appendSystemLogEvent({ action, actor: "Developer", authenticatedBy: "marco@example.com" })
  await fs.appendFile(path.join(root, "system", "events.ndjson"), `${JSON.stringify({ ...expected, id: "legacy", authenticatedBy: undefined })}\n`)
  const filters = { action, actor: "Custode", authenticatedBy: "marco@example.com", limit: 1 }
  assert.deepEqual((await listSystemLogEvents(filters)).items, [expected])
  const response = await app.inject({ method: "GET", url: `/api/system-log?${new URLSearchParams(filters)}`, headers })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().items, [expected])
  assert.deepEqual((await call("list_system_log", filters)).items, [expected])
  assert.ok((await call("list_system_log", { action, actor: "Custode" })).items.some((item) => item.id === "legacy"))
  assert.ok(!(await call("list_system_log", { action, authenticatedBy: "marco@example.com" })).items.some((item) => item.id === "legacy"))
  assert.deepEqual((await call("list_system_log", { action, actor: "custode" })).items, [])
  const invalid = await app.inject({ method: "GET", url: "/api/system-log?actor=one&actor=two", headers })
  assert.equal(invalid.statusCode, 400)
  assert.equal((await app.inject({ method: "GET", url: "/api/system-log?actor=Custode" })).statusCode, 401)
})

test("task tags survive MCP/REST edits, are revision checked, and explicit empty arrays clear them", async () => {
  await storage.createProject({ name: "tags" })
  const created = await call("create_task", {
    projectId: "tags", title: "Tagged task", body: "Original body", tags: [" handoff ", "gate", "handoff", "", "one,two"], agentName: "Creator"
  })
  assert.deepEqual(created.tags, ["handoff", "gate", "one,two"])
  assert.match(created.content, /tags: \["handoff","gate","one,two"\]/)
  const url = `/api/projects/tags/tasks/content?path=${encodeURIComponent(created.path)}`
  const response = await app.inject({ method: "PATCH", url, headers, payload: { title: "New title", expectedRevision: created.revision } })
  assert.equal(response.statusCode, 200, response.body)
  const renamed = response.json()
  assert.deepEqual(renamed.tags, created.tags)
  const edited = await call("update_task", {
    projectId: "tags", path: created.path, tags: ["review"], expectedRevision: renamed.revision, agentName: "Editor"
  })
  assert.equal(edited.createdBy, "Creator")
  assert.equal(edited.updatedBy, "Editor")
  assert.equal(edited.id, created.id)
  assert.deepEqual(edited.tags, ["review"])
  assert.match(edited.content, /Original body/)
  assert.equal((await storage.searchFiles({ query: "New title", tag: "review", type: "tasks" }))[0].id, created.id)
  const stale = await app.inject({ method: "PATCH", url, headers, payload: { tags: [], expectedRevision: renamed.revision } })
  assert.equal(stale.statusCode, 409)
  assert.deepEqual((await storage.readTask("tags", created.path)).tags, ["review"])
  const cleared = await app.inject({ method: "PATCH", url, headers, payload: { tags: [], expectedRevision: edited.revision } })
  assert.equal(cleared.statusCode, 200, cleared.body)
  assert.deepEqual(cleared.json().tags, [])
  for (const tags of ["one,two", null, [123], {}]) {
    const invalid = await app.inject({ method: "POST", url: "/api/projects/tags/tasks", headers, payload: { title: "Invalid tags", tags } })
    assert.equal(invalid.statusCode, 400, invalid.body)
  }
})

test("tag filters combine with other filters and cursors bind the exact tag even when matching records are identical", async () => {
  await storage.createProject({ name: "tag-queries" })
  const first = await storage.createTask("tag-queries", { title: "First", tags: ["handoff", "shared"], owner: "Alice" })
  await storage.createTask("tag-queries", { title: "Other", tags: ["other"], owner: "Alice" })
  const last = await storage.createTask("tag-queries", { title: "Last", tags: ["handoff", "shared"], owner: "Alice" })
  const filters = { tag: "handoff", owner: "Alice", limit: 1 }
  const page = await call("list_tasks", { projectId: "tag-queries", ...filters })
  assert.equal(page.items[0].id, first.id)
  const response = await app.inject({ method: "GET", url: `/api/projects/tag-queries/tasks?${new URLSearchParams(filters)}`, headers })
  assert.deepEqual(response.json(), page)
  const next = await call("list_tasks", { projectId: "tag-queries", ...filters, cursor: page.nextCursor })
  assert.equal(next.items[0].id, last.id)
  assert.equal(next.nextCursor, null)
  await assert.rejects(storage.listTasks("tag-queries", { ...filters, tag: "shared", cursor: page.nextCursor }), { statusCode: 409 })
  assert.equal((await storage.listTasks("tag-queries", { tag: "handoff", owner: "Bob" })).length, 0)
  const invalid = await app.inject({ method: "GET", url: "/api/projects/tag-queries/tasks?tag=one&tag=two", headers })
  assert.equal(invalid.statusCode, 400)
})

test("internal Assistant tools create, replace and filter task tags using the same storage path", async () => {
  await storage.createProject({ name: "assistant-tags" })
  const tools = resolveAgentTools(["create_task", "update_task", "list_tasks"], {
    projectId: "assistant-tags", actor: "assistant", read: ["tasks/**"], write: ["tasks/**"]
  })
  const tool = (name) => tools.find((item) => item.name === name)
  const created = await tool("create_task").invoke({ title: "Assistant tags", tags: ["handoff"] })
  assert.deepEqual(created.tags, ["handoff"])
  const edited = await tool("update_task").invoke({ path: created.path, tags: ["review"], expectedRevision: created.revision })
  assert.deepEqual(edited.tags, ["review"])
  assert.equal((await tool("list_tasks").invoke({ tag: "handoff" })).length, 0)
  assert.equal((await tool("list_tasks").invoke({ tag: "review" }))[0].id, created.id)
})
