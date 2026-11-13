import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { splitTaskComments, withTaskComment } from "./task-comments.js"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-task-comments-"))
Object.assign(process.env, {
  NODE_ENV: "test", AUTH_MODE: "none", AUTH_USERS: "", DEVSYNC_AUTH_USERS: "",
  DEVSYNC_API_TOKEN: "comments-test-token", DEVSYNC_DATA_ROOT: root, DEVSYNC_DATA_DIR: "",
  DEVSYNC_VAULT_NAME: "vault", DEVSYNC_WEB_DIST: path.join(root, "web")
})
const storage = await import("./storage.js")
const { app } = await import("./index.js")
const { createDevsyncMcpServer } = await import("./mcp-server.js")
const { listSystemLogEvents } = await import("./system-log.js")
const { resolveAgentTools } = await import("./agent-tools.js")
const { getAssistantConfig } = await import("./assistant-config.js")
const { taskEvents } = await import("./task-events.js")
const server = createDevsyncMcpServer({ user: { email: "marco@example.com" } })
const client = new Client({ name: "task-comments-test", version: "1" })
const [left, right] = InMemoryTransport.createLinkedPair()
await server.connect(right)
await client.connect(left)
const headers = { authorization: "Bearer comments-test-token" }
after(async () => { await client.close(); await server.close(); await app.close(); await fs.rm(root, { recursive: true, force: true }) })

async function fixture(name, body = "Original **description**.") {
  await storage.createProject({ name })
  return storage.createTask(name, { title: "Task", body, owner: "Alice", status: "doing", tags: ["handoff"], deadline: "2026-12-01", author: "Original author" })
}

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args })
  assert.ok(!response.isError, JSON.stringify(response))
  return JSON.parse(response.content[0].text)
}

function body(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim()
}

function commentsUrl(projectId, taskPath) {
  return `/api/projects/${projectId}/tasks/comments?path=${encodeURIComponent(taskPath)}`
}

test("comments live in the task Markdown with stable metadata and description separated for editing", async () => {
  const original = await fixture("format", "Original **description**.\r\n\r\n## Comments\r\nAn ordinary legacy heading stays in the description.")
  assert.deepEqual(original.comments, [])
  assert.equal(original.descriptionContent, original.content)
  const author = "Custode *QA* <!-- label -->"
  const text = "First comment.\r\n\r\n# A heading\r\n```js\r\nconst answer = 42\r\n```"
  const result = await storage.appendTaskComment("format", original.path, { content: text, author })
  assert.equal(result.comment.author, author)
  assert.equal(result.comment.content, text)
  assert.match(result.comment.id, /^[0-9a-f-]{36}$/)
  assert.ok(Number.isFinite(Date.parse(result.comment.createdAt)))
  const task = await storage.readTask("format", original.path)
  assert.equal(task.content, await fs.readFile(path.join(storage.dataDir, "format", task.path), "utf8"))
  assert.match(task.content, /<!-- devsync:task-comments -->\n## Comments/)
  assert.match(task.content, /\*QA\\\*/)
  assert.deepEqual(task.comments, [result.comment])
  assert.equal(body(task.descriptionContent), body(original.content))
  for (const key of ["id", "createdBy", "title", "owner", "status", "order", "deadline", "tags"]) assert.deepEqual(task[key], original[key], key)
  assert.notEqual(task.revision, original.revision)
  assert.equal(result.task.revision, result.revision)
  assert.deepEqual(result.task.comments, task.comments)
  const summary = (await storage.listTasks("format"))[0]
  assert.ok(!("comments" in summary) && !("descriptionContent" in summary), "Task summaries remain compact")
  assert.deepEqual((await call("read_task", { projectId: "format", path: original.path })).comments, task.comments)
  assert.equal((await storage.searchFiles({ query: "answer", type: "tasks", projectId: "format" }))[0].id, task.id)
  const unusualName = "Custode <!-- devsync:task-comments -->"
  await call("append_task_comment", { projectId: "format", path: task.path, content: "A safe declared name", agentName: unusualName })
  assert.equal((await storage.readTask("format", task.path)).comments[1].author, unusualName)
})

test("concurrent REST and MCP appends retain every comment without a client revision", async () => {
  const task = await fixture("concurrent-comments")
  const count = 10
  const results = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const content = `Concurrent message ${index}.`
    if (index % 2 === 0) return call("append_task_comment", { projectId: "concurrent-comments", path: task.path, content, agentName: "Developer" })
    const response = await app.inject({ method: "POST", url: commentsUrl("concurrent-comments", task.path), headers, payload: { content, agentName: "Custode", expectedRevision: task.revision } })
    assert.equal(response.statusCode, 201, response.body)
    return response.json()
  }))
  assert.equal(new Set(results.map((result) => result.comment.id)).size, count)
  const saved = await storage.readTask("concurrent-comments", task.path)
  assert.equal(saved.comments.length, count)
  assert.equal(new Set(saved.comments.map((comment) => comment.content)).size, count)
  assert.deepEqual(new Set(saved.comments.map((comment) => comment.id)), new Set(results.map((result) => result.comment.id)))
  const offsets = saved.comments.map((comment) => saved.content.indexOf(`"id":"${comment.id}"`))
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b))
  assert.equal(body(saved.descriptionContent), body(task.content))
  assert.equal(saved.status, task.status)
  await assert.rejects(storage.updateTask("concurrent-comments", task.path, { body: "Stale description", expectedRevision: task.revision }), { statusCode: 409 })
})

test("description, metadata, full Markdown and generic document edits preserve the exact comment section", async () => {
  let task = await fixture("preservation")
  const first = await storage.appendTaskComment("preservation", task.path, { content: "First comment", author: "Custode" })
  await storage.appendTaskComment("preservation", task.path, { content: "# A comment heading\n\nSecond comment", author: "Developer" })
  task = await storage.readTask("preservation", task.path)
  const section = splitTaskComments(task.content).section
  task = await storage.updateTask("preservation", task.path, { body: "Revised description", tags: ["review"], status: "done", expectedRevision: task.revision })
  assert.equal(splitTaskComments(task.content).section, section)
  task = await storage.updateTask("preservation", task.path, { content: "Plain description without a heading", expectedRevision: task.revision })
  task = await storage.updateTask("preservation", task.path, { title: "Renamed task", expectedRevision: task.revision })
  assert.equal(splitTaskComments(task.content).section, section, "Renaming cannot alter a heading inside a comment")
  let doc = await storage.updateDocument({ projectId: "preservation", path: task.path, content: "# Document edit\nDescription only", expectedRevision: task.revision })
  task = await storage.readTask("preservation", task.path)
  assert.equal(splitTaskComments(task.content).section, section)
  doc = await call("update_document", { ref: doc.id, content: doc.content, title: "New document title", expectedRevision: doc.revision })
  task = await storage.readTask("preservation", task.path)
  assert.equal(splitTaskComments(task.content).section, section)
  assert.equal(task.comments[0].id, first.comment.id)
  assert.equal(task.title, "New document title")
  const reordered = await storage.reorderTasks("preservation", { items: [{ path: task.path, expectedRevision: task.revision }] })
  task = await storage.readTask("preservation", task.path)
  assert.equal(task.revision, reordered[0].revision)
  assert.equal(splitTaskComments(task.content).section, section)
})

test("existing comments cannot be changed, deleted or manufactured through task/document updates", async () => {
  let task = await fixture("append-only")
  await storage.appendTaskComment("append-only", task.path, { content: "Original comment", author: "Custode" })
  task = await storage.readTask("append-only", task.path)
  const forged = withTaskComment(task.content, { id: randomUUID(), author: "Forged", createdAt: new Date().toISOString(), content: "Forged comment" })
  for (const content of [task.content.replace("Original comment", "Changed comment"), forged, `${task.descriptionContent}<!-- devsync:task-comments -->\n## Comments\n`]) {
    await assert.rejects(storage.updateTask("append-only", task.path, { content, expectedRevision: task.revision }), { statusCode: 400 })
    await assert.rejects(storage.updateDocument({ projectId: "append-only", path: task.path, content, expectedRevision: task.revision }), { statusCode: 400 })
    assert.equal((await storage.readTask("append-only", task.path)).content, task.content)
  }
  const response = await app.inject({ method: "PATCH", url: `/api/projects/append-only/tasks/content?path=${encodeURIComponent(task.path)}`, headers, payload: { content: task.content.replace("Original comment", "REST alteration"), expectedRevision: task.revision } })
  assert.equal(response.statusCode, 400)
  const removed = await app.inject({ method: "DELETE", url: commentsUrl("append-only", task.path), headers })
  assert.equal(removed.statusCode, 404)
  const copy = await app.inject({ method: "POST", url: "/api/projects/append-only/tasks", headers, payload: { title: "Copy", body: task.content } })
  assert.equal(copy.statusCode, 400)
})

test("server attribution, timestamps, audit identity, mentions and task events agree across channels", async () => {
  const task = await fixture("comment-attribution")
  const captured = []
  const listener = (event) => { if (event.projectId === "comment-attribution") captured.push(event) }
  taskEvents.on("event", listener)
  try {
    const comment = await call("append_task_comment", { projectId: "comment-attribution", path: task.path, content: "Ping @[Marco](devsync:user:marco@example.com)", agentName: "Custode", author: "forged", createdAt: "1999-01-01", id: "forged", authenticatedBy: "forged" })
    assert.equal(comment.comment.author, "Custode")
    assert.notEqual(comment.comment.createdAt, "1999-01-01")
    assert.ok(!("task" in comment), "MCP append replies do not duplicate the entire discussion")
    const response = await app.inject({ method: "POST", url: commentsUrl("comment-attribution", task.path), headers, payload: { content: "REST fallback", author: "forged", authenticatedBy: "forged", createdAt: "1999-01-01" } })
    assert.equal(response.statusCode, 201)
    assert.equal(response.json().comment.author, "api-token")
    assert.equal(response.json().task.comments.length, 2)
    const events = (await listSystemLogEvents({ unbounded: true })).items.filter((event) => event.projectId === "comment-attribution")
    const audit = events.find((event) => event.action === "task.comment_added" && event.actor === "Custode")
    assert.equal(audit.authenticatedBy, "marco@example.com")
    assert.equal(audit.metadata.commentId, comment.comment.id)
    const mention = events.find((event) => event.action === "mention.created")
    assert.equal(mention.actor, "Custode")
    assert.equal(mention.authenticatedBy, "marco@example.com")
    assert.equal(events.find((event) => event.action === "task.comment_added" && event.source === "api").authenticatedBy, "api-token")
    assert.equal(captured.length, 2)
    assert.ok(captured.every((event) => event.type === "task.updated"))
  } finally { taskEvents.off("event", listener) }
})

test("invalid content, unsafe paths and anonymous requests cannot append or create a phantom project", async () => {
  const task = await fixture("comment-security")
  for (const content of ["", "   ", null, {}, "Literal <!-- devsync:task-comment marker"] ) {
    const response = await app.inject({ method: "POST", url: commentsUrl("comment-security", task.path), headers, payload: { content } })
    assert.equal(response.statusCode, 400, response.body)
  }
  for (const taskPath of ["tasks/../resources/file.md", "../outside.md", "tasks/README.md", "resources/file.md", ""]) {
    const response = await app.inject({ method: "POST", url: commentsUrl("comment-security", taskPath), headers, payload: { content: "Invalid target" } })
    assert.equal(response.statusCode, 400, `${taskPath}: ${response.body}`)
  }
  const denied = await app.inject({ method: "POST", url: commentsUrl("comment-security", task.path), payload: { content: "Anonymous" } })
  assert.equal(denied.statusCode, 401)
  const missing = await client.callTool({ name: "append_task_comment", arguments: { projectId: "missing-project", path: "tasks/missing.md", content: "No project" } })
  assert.equal(JSON.parse(missing.content[0].text).statusCode, 404)
  await assert.rejects(fs.access(path.join(storage.dataDir, "missing-project")), { code: "ENOENT" })
  const outside = path.join(root, "outside.md")
  await fs.writeFile(outside, "Outside contents")
  const link = path.join(storage.dataDir, "comment-security", "tasks", "link.md")
  await fs.symlink(outside, link)
  const linked = await app.inject({ method: "POST", url: commentsUrl("comment-security", "tasks/link.md"), headers, payload: { content: "Escape" } })
  assert.equal(linked.statusCode, 400)
  assert.equal(await fs.readFile(outside, "utf8"), "Outside contents")
  await fs.unlink(link)
  assert.equal((await storage.readTask("comment-security", task.path)).revision, task.revision)
})

test("malformed stored comment sections fail explicitly and are never silently rewritten", async () => {
  const task = await fixture("corrupt-comments")
  const result = await storage.appendTaskComment("corrupt-comments", task.path, { content: "Keep this comment", author: "Custode" })
  const file = path.join(storage.dataDir, "corrupt-comments", task.path)
  const raw = await fs.readFile(file, "utf8")
  const corrupt = raw.replace(`"createdAt":"${result.comment.createdAt}"`, '"createdAt":"invalid"')
  await fs.writeFile(file, corrupt)
  await assert.rejects(storage.readTask("corrupt-comments", task.path), { statusCode: 400 })
  await assert.rejects(storage.updateTask("corrupt-comments", task.path, { title: "Overwrite", expectedRevision: result.revision }), { statusCode: 400 })
  assert.equal(await fs.readFile(file, "utf8"), corrupt)
})

test("Assistant comment tools use the same append path and enforce per-file write scope", async () => {
  const task = await fixture("assistant-comments")
  assert.ok((await getAssistantConfig()).tools.includes("append_task_comment"))
  const [tool] = resolveAgentTools(["append_task_comment"], { projectId: "assistant-comments", actor: "assistant", read: ["tasks/**"], write: ["tasks/**"] })
  const result = await tool.invoke({ path: task.path, content: "Assistant comment" })
  assert.equal(result.comment.author, "assistant")
  const [denied] = resolveAgentTools(["append_task_comment"], { projectId: "assistant-comments", read: ["tasks/**"], write: ["tasks/README.md"] })
  await assert.rejects(denied.invoke({ path: task.path, content: "No permission" }), /write permission/i)
  assert.equal((await storage.readTask("assistant-comments", task.path)).comments.length, 1)
})
