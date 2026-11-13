import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { after, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createPasswordHash } from "./auth.js"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-attribution-"))
const marco = "marco@example.com"
Object.assign(process.env, {
  NODE_ENV: "test", AUTH_MODE: "password", AUTH_SESSION_SECRET: "attribution-test-session-secret-at-least-32-chars",
  AUTH_USERS: `${marco}|Marco|${await createPasswordHash("test-password")}`, DEVSYNC_AUTH_USERS: "",
  DEVSYNC_API_TOKEN: "attribution-api-token", DEVSYNC_DATA_ROOT: root, DEVSYNC_DATA_DIR: "",
  DEVSYNC_VAULT_NAME: "vault", DEVSYNC_WEB_DIST: path.join(root, "web")
})
const storage = await import("./storage.js")
const { app } = await import("./index.js")
const { createDevsyncMcpServer } = await import("./mcp-server.js")
const { createMcpTokenForUser } = await import("./mcp-tokens.js")
const { listSystemLogEvents } = await import("./system-log.js")
const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: marco, password: "test-password" } })
assert.equal(login.statusCode, 200)
const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0] }
after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }) })

async function request(method, url, payload, extra = {}) {
  const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }), ...extra })
  assert.ok(response.statusCode < 300, `${method} ${url}: ${response.body}`)
  return response.json()
}

async function audit(projectId) {
  const events = (await listSystemLogEvents({ unbounded: true })).items
  return events.filter((event) => (!projectId || event.projectId === projectId) && ["api", "mcp", "git"].includes(event.source))
}

async function connection(user = { email: marco, name: "Marco" }) {
  const server = createDevsyncMcpServer({ user })
  const client = new Client({ name: "shared-client", version: "1" })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await server.connect(right)
  await client.connect(left)
  return {
    client,
    async call(name, args) {
      const response = await client.callTool({ name, arguments: args })
      assert.ok(!response.isError, JSON.stringify(response))
      return JSON.parse(response.content[0].text)
    },
    close: async () => { await client.close(); await server.close() }
  }
}

test("REST records the optional agent as creator/editor and retains the authenticated user on every task audit event", async () => {
  const project = await request("POST", "/api/projects", { name: "rest-agent", agentName: "Coordinator", authenticatedBy: "forged" })
  const task = await request("POST", `/api/projects/${project.id}/tasks`, {
    title: "Delegated", agentName: "  Custode  ", author: "forged", createdBy: "forged", authenticatedBy: "forged"
  })
  assert.equal(task.createdBy, "Custode")
  assert.equal(task.updatedBy, "Custode")
  const edited = await request("PATCH", `/api/projects/${project.id}/tasks/content?path=${encodeURIComponent(task.path)}`, {
    agentName: "Revisore", expectedRevision: task.revision, status: "doing", owner: marco,
    content: task.content.replace(/createdBy: .*/, 'createdBy: "forged"') + `\n@[Marco](devsync:user:${marco})`,
    authenticatedBy: "forged"
  })
  assert.equal(edited.createdBy, "Custode")
  assert.equal(edited.updatedBy, "Revisore")
  const events = await audit(project.id)
  assert.ok(events.every((event) => event.authenticatedBy === marco))
  assert.equal(events.find((event) => event.action === "project.created").actor, "Coordinator")
  assert.equal(events.find((event) => event.action === "task.created").actor, "Custode")
  for (const action of ["task.updated", "task.assigned", "task.status_changed", "mention.created"]) {
    assert.equal(events.find((event) => event.action === action).actor, "Revisore", action)
  }
  const visible = await request("GET", "/api/system-log?limit=1000")
  assert.equal(visible.items.find((event) => event.action === "task.created" && event.projectId === project.id).authenticatedBy, marco)
})

test("absent, null and whitespace agent names fall back to the signed-in user; shared API tokens keep their technical identity", async () => {
  await storage.createProject({ name: "fallback" })
  for (const agent of [{}, { agentName: "" }, { agentName: "   " }, { agentName: " \t " }, { agentName: null }]) {
    const entry = await request("POST", "/api/projects/fallback/logs", { content: "Fallback", ...agent, author: "forged", authenticatedBy: "forged" })
    assert.equal(entry.author, marco)
  }
  const technical = { authorization: "Bearer attribution-api-token" }
  for (const [agentName, expected] of [["External agent", "External agent"], ["", "api-token"]]) {
    const entry = await request("POST", "/api/projects/fallback/logs", { content: "Technical access", agentName, authenticatedBy: "forged" }, { headers: technical })
    assert.equal(entry.author, expected)
  }
  const events = await audit("fallback")
  assert.equal(events.filter((event) => event.authenticatedBy === marco && event.actor === marco).length, 5)
  assert.equal(events.filter((event) => event.authenticatedBy === "api-token").length, 2)
})

test("documents preserve original authors and REST query attribution covers uploads and body-less deletion", async () => {
  await storage.createProject({ name: "documents-agent" })
  const document = await request("POST", "/%61pi/documents", {
    projectId: "documents-agent", title: "Analysis", content: "# Analysis\nOriginal", agentName: "Writer", authenticatedBy: "forged"
  })
  assert.equal(document.author, "Writer")
  const edited = await request("PATCH", "/api/documents", {
    ref: document.id, expectedRevision: document.revision, content: "# Analysis\nRevised", agentName: "Editor"
  })
  assert.equal(edited.author, "Writer")
  assert.match(edited.content, /lastEditor: "Editor"/)
  const boundary = "----attribution-upload"
  const payload = [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="notes.txt"', "Content-Type: text/plain", "", "Upload text", `--${boundary}--`, ""].join("\r\n")
  const upload = await request("POST", "/api/projects/documents-agent/resources/upload?agentName=Uploader", payload, {
    headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` }
  })
  await request("DELETE", `/api/projects/documents-agent/resources?path=${encodeURIComponent(upload.path)}&agentName=Archivist&authenticatedBy=forged`)
  const events = await audit("documents-agent")
  assert.ok(events.every((event) => event.authenticatedBy === marco))
  assert.equal(events.find((event) => event.action === "artifact.uploaded").actor, "Uploader")
  assert.equal(events.find((event) => event.action === "artifact.deleted").actor, "Archivist")
  assert.equal(events.find((event) => event.action === "document.created").actor, "Writer")
  assert.equal(events.find((event) => event.action === "document.updated").actor, "Editor")
})

test("concurrent agents share one MCP client without leaking attribution, including authenticated fallback", async () => {
  await storage.createProject({ name: "mcp-concurrent" })
  const conn = await connection()
  try {
    const names = ["Developer", "Custode", "Designer", "", undefined, null]
    const entries = await Promise.all(names.map((agentName, index) => conn.call("append_log", {
      projectId: "mcp-concurrent", content: `Parallel ${index}`, ...(agentName === undefined ? {} : { agentName }),
      author: "forged", authenticatedBy: "forged"
    })))
    assert.deepEqual(entries.map((entry) => entry.author), names.map((name) => name || marco))
    const events = await audit("mcp-concurrent")
    assert.equal(events.length, names.length)
    for (let index = 0; index < names.length; index++) {
      const event = events.find((event) => event.summary === `Parallel ${index}`)
      assert.equal(event.actor, names[index] || marco)
      assert.equal(event.authenticatedBy, marco)
    }
  } finally { await conn.close() }
})

test("every MCP mutation exposes agentName and keeps authenticated audit attribution through task and document lifecycle", async () => {
  await storage.createProject({ name: "mcp-lifecycle" })
  const conn = await connection()
  try {
    const { tools } = await conn.client.listTools()
    const writes = ["append_log", "create_document", "update_document", "create_task", "update_task", "toggle_task", "reorder_tasks", "delete_task"]
    for (const name of writes) {
      const schema = tools.find((tool) => tool.name === name).inputSchema
      assert.ok(schema.properties.agentName, name)
      assert.ok(!schema.required?.includes("agentName"), name)
    }
    const projectId = "mcp-lifecycle"
    const first = await conn.call("create_task", { projectId, title: "MCP lifecycle", agentName: "Creator" })
    assert.equal(first.createdBy, "Creator")
    const edited = await conn.call("update_task", { projectId, path: first.path, body: `@[Marco](devsync:user:${marco})`, owner: marco, agentName: "Editor", expectedRevision: first.revision })
    assert.equal(edited.createdBy, "Creator")
    assert.equal(edited.updatedBy, "Editor")
    await conn.call("toggle_task", { projectId, path: first.path, done: true, agentName: "Closer", expectedRevision: edited.revision })
    const closed = await storage.readTask(projectId, first.path)
    const reordered = await conn.call("reorder_tasks", { projectId, items: [{ path: first.path, expectedRevision: closed.revision }], agentName: "Coordinator" })
    await conn.call("delete_task", { projectId, path: first.path, expectedRevision: reordered[0].revision, agentName: "Archivist" })
    const document = await conn.call("create_document", { projectId, title: "MCP document", content: "Original", agentName: "Document writer" })
    const updated = await conn.call("update_document", { ref: document.id, content: "Revised", expectedRevision: document.revision, agentName: "Document editor" })
    assert.equal(updated.author, "Document writer")
    assert.match(updated.content, /lastEditor: "Document editor"/)
    const events = await audit(projectId)
    assert.ok(events.every((event) => event.authenticatedBy === marco))
    for (const [action, actor] of [["task.created", "Creator"], ["task.assigned", "Editor"], ["mention.created", "Editor"], ["task.reordered", "Coordinator"], ["task.deleted", "Archivist"], ["document.created", "Document writer"], ["document.updated", "Document editor"]]) {
      assert.equal(events.find((event) => event.action === action).actor, actor, action)
    }
  } finally { await conn.close() }
})

test("HTTP MCP personal token retains its authenticated owner despite a declared agent or forged audit field", async () => {
  await storage.createProject({ name: "mcp-personal" })
  const { token } = await createMcpTokenForUser({ email: marco, name: "Marco" })
  const response = await app.inject({ method: "POST", url: "/mcp", payload: {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "append_log", arguments: { projectId: "mcp-personal", content: "Personal token", agentName: "Custode", authenticatedBy: "forged" }
    }
  }, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" } })
  assert.equal(response.statusCode, 200, response.body)
  const result = JSON.parse(response.body.split("\n").find((line) => line.startsWith("data: ")).slice(6))
  assert.equal(JSON.parse(result.result.content[0].text).author, "Custode")
  const [event] = await audit("mcp-personal")
  assert.equal(event.actor, "Custode")
  assert.equal(event.authenticatedBy, marco)
})

test("local stdio retains its technical identity with or without a declared agent", async () => {
  await storage.createProject({ name: "stdio-agent" })
  const conn = await connection()
  const local = await connection(null)
  try {
    for (const agentName of ["Custode", ""]) {
      const entry = await local.call("append_log", { projectId: "stdio-agent", content: "Local call", agentName })
      assert.equal(entry.author, agentName || "local-stdio")
    }
    assert.ok((await audit("stdio-agent")).every((event) => event.authenticatedBy === "local-stdio"))
    // A following user call must not inherit the local client's identity.
    const entry = await conn.call("append_log", { projectId: "stdio-agent", content: "User call" })
    assert.equal(entry.author, marco)
    assert.equal((await audit("stdio-agent"))[0].authenticatedBy, marco)
  } finally { await local.close(); await conn.close() }
})

test("invalid names fail before writes and do not grant unauthenticated REST access", async () => {
  await storage.createProject({ name: "invalid-agent" })
  const conn = await connection()
  try {
    for (const agentName of [12, {}, ["Custode"], "First\nSecond", "First\rSecond", "Null\u0000byte", "x".repeat(101)]) {
      const rest = await app.inject({ method: "POST", url: "/api/projects/invalid-agent/logs", headers, payload: { content: "Invalid", agentName } })
      assert.equal(rest.statusCode, 400, rest.body)
      const mcp = await conn.client.callTool({ name: "append_log", arguments: { projectId: "invalid-agent", content: "Invalid", agentName } })
      assert.ok(mcp.isError)
    }
    const denied = await app.inject({ method: "POST", url: "/api/projects/invalid-agent/logs", payload: { content: "No access", agentName: "Marco" } })
    assert.equal(denied.statusCode, 401)
    assert.deepEqual(await audit("invalid-agent"), [])
  } finally { await conn.close() }
})

test("REST git audit keeps declared author and authenticated caller even when a local pull fails", async () => {
  await promisify(execFile)("git", ["init", storage.vaultDir])
  const result = await request("POST", "/api/git/pull", { agentName: "Synchronizer", authenticatedBy: "forged" })
  assert.equal(result.ok, false, "The isolated test repo has no remote")
  const event = (await audit()).find((event) => event.action === "git.pull")
  assert.equal(event.actor, "Synchronizer")
  assert.equal(event.authenticatedBy, marco)
})
