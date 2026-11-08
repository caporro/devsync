import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-without-planning-"))
const vault = path.join(root, "vault")
Object.assign(process.env, {
  NODE_ENV: "test", AUTH_MODE: "none", DEVSYNC_API_TOKEN: "",
  DEVSYNC_DATA_ROOT: root, DEVSYNC_DATA_DIR: "", DEVSYNC_VAULT_NAME: "vault",
  DEVSYNC_WEB_DIST: path.join(root, "web"), DEVSYNC_PUBLIC_URL: "",
})
await fs.mkdir(vault)
await fs.mkdir(process.env.DEVSYNC_WEB_DIST)
await fs.writeFile(path.join(process.env.DEVSYNC_WEB_DIST, "index.html"), "<!doctype html><html></html>")

const historicalFiles = []
for (const name of ["vault-plan.json", "gantt.json"]) {
  const file = path.join(vault, name)
  const content = Buffer.from(`{ "tasks": [{ "id": "old-step", "text": "Historical plan", "custom": "preserve" }], "links": [], "updatedAt": "2020-01-01" }\n`)
  await fs.writeFile(file, content)
  await fs.utimes(file, new Date("2020-01-01"), new Date("2020-01-01"))
  historicalFiles.push({ file, content, mtimeMs: (await fs.stat(file)).mtimeMs })
}

const { app } = await import("./index.js")
const { createDevsyncMcpServer } = await import("./mcp-server.js")
after(async () => {
  try {
    await app.close()
    for (const { file, content, mtimeMs } of historicalFiles) {
      assert.deepEqual(await fs.readFile(file), content)
      assert.equal((await fs.stat(file)).mtimeMs, mtimeMs)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("retired planning endpoints return 404 and old UI bookmarks redirect home", async () => {
  for (const method of ["GET", "PUT"]) {
    const response = await app.inject({ method, url: "/api/planning", ...(method === "PUT" ? { payload: { tasks: [], links: [] } } : {}) })
    assert.equal(response.statusCode, 404)
    assert.deepEqual(response.json(), { error: "Not found" })
  }
  const response = await app.inject({ method: "GET", url: "/planning" })
  assert.equal(response.statusCode, 302)
  assert.equal(response.headers.location, "/")
})

test("Tasks, My Tasks, legacy task aliases and MCP remain usable without Planning", async () => {
  const project = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "kept-tasks" } })
  assert.equal(project.statusCode, 201)
  const projectId = project.json().id
  const created = await app.inject({ method: "POST", url: `/api/projects/${projectId}/tasks`, payload: { title: "Kept task", owner: "team", deadline: "2026-11-10", body: "Retained Markdown task" } })
  assert.equal(created.statusCode, 201)
  const taskPath = created.json().path
  const query = `?path=${encodeURIComponent(taskPath)}`
  const tasks = () => app.inject({ method: "GET", url: "/api/my/tasks" })
  assert.equal((await tasks()).json().items[0].items[0].path, taskPath)
  const legacy = await app.inject({ method: "GET", url: "/api/my/plan-items" })
  assert.deepEqual(legacy.json(), (await tasks()).json())

  const client = new Client({ name: "task-retention-test", version: "1.0.0" })
  const server = createDevsyncMcpServer({ user: { email: "team" } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    for (const name of ["list_tasks", "read_task", "create_task", "update_task", "toggle_task", "delete_task"]) assert.ok(names.includes(name), name)
    const result = await client.callTool({ name: "read_task", arguments: { projectId, path: taskPath } })
    assert.ok(!result.isError)
    assert.match(JSON.parse(result.content[0].text).content, /Retained Markdown task/)
  } finally {
    await client.close()
    await server.close()
  }

  const updated = await app.inject({ method: "PATCH", url: `/api/projects/${projectId}/tasks/content${query}`, payload: { title: "Updated task", owner: "team", body: "Updated Markdown task" } })
  assert.equal(updated.statusCode, 200)
  assert.equal((await tasks()).json().items[0].items[0].title, "Updated task")
  const toggled = await app.inject({ method: "PATCH", url: `/api/projects/${projectId}/plan/toggle${query}`, payload: { done: true } })
  assert.equal(toggled.statusCode, 200)
  assert.equal((await tasks()).json().items[0].items[0].done, true)
  const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/tasks${query}` })
  assert.equal(deleted.statusCode, 200)
  assert.deepEqual((await tasks()).json().items, [])
})
