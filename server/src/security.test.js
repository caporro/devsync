import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { createPasswordHash } from "./auth.js"
import { clearRateLimits } from "./rate-limit.js"

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-security-"))
const webDist = path.join(tempRoot, "web-dist")
const vaultName = "security-vault"
const password = "correct horse battery staple"
const passwordHash = await createPasswordHash(password)

process.env.NODE_ENV = "test"
process.env.DEVSYNC_DATA_ROOT = tempRoot
process.env.DEVSYNC_VAULT_NAME = vaultName
process.env.DEVSYNC_WEB_DIST = webDist
process.env.AUTH_MODE = "password"
process.env.AUTH_SESSION_SECRET = "test-session-secret-with-at-least-32-chars"
process.env.AUTH_USERS = `security@example.com|Security User|${passwordHash}`
process.env.DEVSYNC_RATE_LIMIT_WINDOW_MS = "60000"
process.env.DEVSYNC_LOGIN_USER_LIMIT = "2"
process.env.DEVSYNC_LOGIN_IP_LIMIT = "20"
process.env.DEVSYNC_MCP_AUTH_LIMIT = "1"
process.env.DEVSYNC_MCP_TOKEN_CREATE_LIMIT = "1"

await fs.mkdir(webDist, { recursive: true })
await fs.writeFile(path.join(webDist, "index.html"), "<!doctype html><html></html>\n", "utf8")

const { app } = await import("./index.js")
const { resolveAgentTools } = await import("./agent-tools.js")
const { summarizeToolPayload } = await import("./ai-logging.js")
const { ensureDataDir } = await import("./storage.js")
const {
  diffAutomationWriteSnapshots,
  snapshotAutomationWritePaths,
} = await import("./automation-runtime.js")

after(async () => {
  await app.close()
  await fs.rm(tempRoot, { recursive: true, force: true })
})

function jsonHeaders(extra = {}) {
  return {
    "content-type": "application/json",
    ...extra,
  }
}

function sessionCookie(response) {
  const value = response.headers["set-cookie"]
  const cookie = Array.isArray(value) ? value[0] : value

  assert.ok(cookie, "login response should set a session cookie")
  return String(cookie).split(";")[0]
}

async function login() {
  clearRateLimits()
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      email: "security@example.com",
      password,
    }),
  })

  assert.equal(response.statusCode, 200)
  return sessionCookie(response)
}

async function createProject(cookie, slug) {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: jsonHeaders({ cookie }),
    payload: JSON.stringify({
      name: slug,
      slug,
    }),
  })

  assert.equal(response.statusCode, 201)
  return response.json().id
}

function projectDir(projectId) {
  return path.join(tempRoot, vaultName, "projects", projectId)
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

async function writeProjectFile(projectId, relativePath, content) {
  const target = path.join(projectDir(projectId), relativePath)

  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

async function patchJson(url, cookie, body = { content: "# changed\n" }) {
  return app.inject({
    method: "PATCH",
    url,
    headers: jsonHeaders({ cookie }),
    payload: JSON.stringify(body),
  })
}

test("login failures are rate limited", async () => {
  clearRateLimits()

  const request = () => app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      email: "security@example.com",
      password: "wrong",
    }),
  })

  assert.equal((await request()).statusCode, 401)
  assert.equal((await request()).statusCode, 401)

  const blocked = await request()

  assert.equal(blocked.statusCode, 429)
  assert.equal(blocked.json().error, "Too many attempts. Try again later.")
  assert.ok(Number(blocked.headers["retry-after"]) > 0)
})

test("project folders without metadata are listed and repaired on write", async () => {
  const cookie = await login()
  const projectId = "20-Manual-Import"
  const root = projectDir(projectId)

  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, "README.md"), "# Manual Import\n", "utf8")

  const response = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { cookie },
  })

  assert.equal(response.statusCode, 200)
  const project = response.json().items.find((item) => item.id === projectId)
  assert.ok(project)
  assert.equal(project.name, "20 Manual Import")
  assert.equal(await pathExists(path.join(root, "project.json")), false)

  const update = await app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    headers: jsonHeaders({ cookie }),
    payload: JSON.stringify({ owner: "team" }),
  })

  assert.equal(update.statusCode, 200)

  const metadata = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"))
  assert.equal(metadata.owner, "team")
  assert.equal(metadata.status, "active")
  assert.deepEqual(metadata.tags, [])
})

test("legacy plan folders migrate to tasks folders", async () => {
  const projectId = "legacy-plan-migration"
  const root = projectDir(projectId)

  await fs.mkdir(path.join(root, "plan"), { recursive: true })
  await fs.writeFile(path.join(root, "project.json"), "{}\n", "utf8")
  await fs.writeFile(path.join(root, "plan", "README.md"), "# Plan\n\n- [ ] [Do thing](do-thing.md)\n", "utf8")
  await fs.writeFile(path.join(root, "plan", "do-thing.md"), "# Do thing\n", "utf8")

  await ensureDataDir()

  assert.equal(await pathExists(path.join(root, "plan")), false)
  assert.equal(await pathExists(path.join(root, "tasks")), true)
  assert.match(await fs.readFile(path.join(root, "tasks", "README.md"), "utf8"), /^# Tasks/m)
})

test("new projects create resources and work folders", async () => {
  const cookie = await login()
  const projectId = await createProject(cookie, "security-new-folders")
  const root = projectDir(projectId)

  assert.equal(await pathExists(path.join(root, "resources")), true)
  assert.equal(await pathExists(path.join(root, "work")), true)
  assert.equal(await pathExists(path.join(root, "artifacts")), false)
  assert.equal(await pathExists(path.join(root, "generated")), false)
})

test("legacy artifacts and generated folders migrate to resources and work", async () => {
  const cookie = await login()
  const projectId = "legacy-resource-migration"
  const root = projectDir(projectId)

  await fs.mkdir(path.join(root, "artifacts"), { recursive: true })
  await fs.mkdir(path.join(root, "generated"), { recursive: true })
  await fs.writeFile(path.join(root, "project.json"), "{}\n", "utf8")
  await fs.writeFile(path.join(root, "artifacts", "source.md"), "# Source\n", "utf8")
  await fs.writeFile(path.join(root, "generated", "report.md"), "# Report\n", "utf8")

  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}`,
    headers: { cookie },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(await pathExists(path.join(root, "artifacts")), false)
  assert.equal(await pathExists(path.join(root, "generated")), false)
  assert.equal(await pathExists(path.join(root, "resources", "source.md")), true)
  assert.equal(await pathExists(path.join(root, "work", "report.md")), true)
  assert.deepEqual(response.json().files.resources.map((file) => file.path), ["resources/source.md"])
  assert.deepEqual(response.json().files.work.map((file) => file.path), ["work/report.md"])
})

test("legacy folders are still read when canonical folders already exist", async () => {
  const cookie = await login()
  const projectId = "legacy-resource-coexist"
  const root = projectDir(projectId)

  await fs.mkdir(path.join(root, "resources"), { recursive: true })
  await fs.mkdir(path.join(root, "artifacts"), { recursive: true })
  await fs.mkdir(path.join(root, "work"), { recursive: true })
  await fs.mkdir(path.join(root, "generated"), { recursive: true })
  await fs.writeFile(path.join(root, "project.json"), "{}\n", "utf8")
  await fs.writeFile(path.join(root, "resources", "current.md"), "# Current\n", "utf8")
  await fs.writeFile(path.join(root, "artifacts", "legacy.md"), "# Legacy\n", "utf8")
  await fs.writeFile(path.join(root, "work", "current.md"), "# Current\n", "utf8")
  await fs.writeFile(path.join(root, "generated", "legacy.md"), "# Legacy\n", "utf8")

  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}`,
    headers: { cookie },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(await pathExists(path.join(root, "artifacts", "legacy.md")), true)
  assert.equal(await pathExists(path.join(root, "generated", "legacy.md")), true)
  assert.deepEqual(
    response.json().files.resources.map((file) => file.path).sort(),
    ["resources/current.md", "resources/legacy.md"]
  )
  assert.deepEqual(
    response.json().files.work.map((file) => file.path).sort(),
    ["work/current.md", "work/legacy.md"]
  )

  const update = await patchJson(
    `/api/projects/${projectId}/resources/content?path=${encodeURIComponent("resources/legacy.md")}`,
    cookie,
    { content: "# Updated legacy\n" }
  )

  assert.equal(update.statusCode, 200)
  assert.match(await fs.readFile(path.join(root, "artifacts", "legacy.md"), "utf8"), /# Updated legacy/)
})

test("invalid MCP bearer attempts are rate limited", async () => {
  clearRateLimits()

  const request = () => app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: "Bearer devsync_mcp_invalid.invalid",
    },
  })

  assert.equal((await request()).statusCode, 401)

  const blocked = await request()

  assert.equal(blocked.statusCode, 429)
  assert.ok(Number(blocked.headers["retry-after"]) > 0)
})

test("MCP token creation is rate limited per user", async () => {
  const cookie = await login()

  const createToken = (name) => app.inject({
    method: "POST",
    url: "/api/mcp-tokens",
    headers: jsonHeaders({ cookie }),
    payload: JSON.stringify({ name }),
  })

  const first = await createToken("first")

  assert.equal(first.statusCode, 200)
  assert.match(first.json().token, /^devsync_mcp_/)

  const blocked = await createToken("second")

  assert.equal(blocked.statusCode, 429)
  assert.ok(Number(blocked.headers["retry-after"]) > 0)
})

test("project write routes reject path traversal", async () => {
  const cookie = await login()
  const projectId = await createProject(cookie, "security-paths")
  const metadataPath = path.join(projectDir(projectId), "project.json")
  const originalMetadata = await fs.readFile(metadataPath, "utf8")
  const traversal = encodeURIComponent("../project.json")

  const attempts = [
    `/api/projects/${projectId}/resources/content?path=${traversal}`,
    `/api/projects/${projectId}/work/content?path=${traversal}`,
    `/api/projects/${projectId}/tasks/content?path=${traversal}`,
  ]

  for (const url of attempts) {
    const response = await patchJson(url, cookie)
    assert.equal(response.statusCode, 400, url)
  }

  assert.equal(await fs.readFile(metadataPath, "utf8"), originalMetadata)
})

test("raw project reads reject path traversal", async () => {
  const cookie = await login()
  const projectId = await createProject(cookie, "security-reads")
  const traversal = encodeURIComponent("../project.json")
  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/files/raw?path=${traversal}`,
    headers: { cookie },
  })

  assert.equal(response.statusCode, 400)
})

test("project file routes reject symlink escapes", async () => {
  const cookie = await login()
  const projectId = await createProject(cookie, "security-symlinks")
  const outside = path.join(tempRoot, "outside-secret.md")
  const linkPath = path.join(projectDir(projectId), "resources", "escape.md")

  await fs.writeFile(outside, "do not expose\n", "utf8")
  await fs.symlink(outside, linkPath)

  const raw = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/files/raw?path=${encodeURIComponent("resources/escape.md")}`,
    headers: { cookie },
  })
  const download = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/files/download?path=${encodeURIComponent("resources/escape.md")}`,
    headers: { cookie },
  })
  const write = await patchJson(
    `/api/projects/${projectId}/resources/content?path=${encodeURIComponent("resources/escape.md")}`,
    cookie,
    { content: "# overwritten\n" }
  )

  assert.equal(raw.statusCode, 400)
  assert.equal(download.statusCode, 400)
  assert.equal(write.statusCode, 400)
  assert.equal(await fs.readFile(outside, "utf8"), "do not expose\n")
})

test("download responses force safe content headers", async () => {
  const cookie = await login()
  const projectId = await createProject(cookie, "security-downloads")

  await writeProjectFile(projectId, "resources/preview.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeProjectFile(projectId, "resources/vector.svg", "<svg><script>alert(1)</script></svg>\n")

  const png = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/files/download?path=${encodeURIComponent("resources/preview.png")}`,
    headers: { cookie },
  })

  assert.equal(png.statusCode, 200)
  assert.match(String(png.headers["content-disposition"]), /^inline; filename="preview\.png"/)
  assert.match(String(png.headers["content-type"]), /^image\/png/)
  assert.equal(png.headers["x-content-type-options"], "nosniff")
  assert.equal(png.headers["x-frame-options"], "DENY")
  assert.equal(png.headers["cross-origin-resource-policy"], "same-origin")

  const svg = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/files/download?path=${encodeURIComponent("resources/vector.svg")}`,
    headers: { cookie },
  })

  assert.equal(svg.statusCode, 200)
  assert.match(String(svg.headers["content-disposition"]), /^attachment; filename="vector\.svg"/)
  assert.match(String(svg.headers["content-type"]), /^application\/octet-stream/)
  assert.equal(svg.headers["x-content-type-options"], "nosniff")
})

test("uploaded SVG is stored but still downloaded as attachment", async () => {
  const cookie = await login()
  const projectId = await createProject(cookie, "security-upload-svg")
  const boundary = "----devsync-security-test"
  const payload = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="uploaded.svg"',
    "Content-Type: image/svg+xml",
    "",
    "<svg><script>alert(1)</script></svg>",
    `--${boundary}--`,
    "",
  ].join("\r\n"))

  const upload = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/resources/upload`,
    headers: {
      cookie,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(payload.length),
    },
    payload,
  })

  assert.equal(upload.statusCode, 201)
  assert.equal(upload.json().path, "resources/uploaded.svg")

  const download = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/files/download?path=${encodeURIComponent(upload.json().path)}`,
    headers: { cookie },
  })

  assert.equal(download.statusCode, 200)
  assert.match(String(download.headers["content-disposition"]), /^attachment; filename="uploaded\.svg"/)
  assert.match(String(download.headers["content-type"]), /^application\/octet-stream/)
  assert.equal(download.headers["x-content-type-options"], "nosniff")
})

test("custom agent write tools require declared write scope", async () => {
  const cookie = await login()
  const projectId = await createProject(cookie, "security-agent-tools")
  const tools = resolveAgentTools(["save_generated_markdown", "append_activity_log"], {
    projectId,
    read: ["**/*"],
    write: [],
  })
  const generatedTool = tools.find((item) => item.name === "save_generated_markdown")
  const activityTool = tools.find((item) => item.name === "append_activity_log")

  await assert.rejects(
    () => generatedTool.invoke({ fileName: "note.md", content: "hello" }),
    /requires write permission/
  )
  await assert.rejects(
    () => activityTool.invoke({ content: "hello" }),
    /requires write permission/
  )
})

test("assistant can write project automations by default", async () => {
  const cookie = await login()
  const projectId = await createProject(cookie, "security-assistant-automations")
  const response = await app.inject({
    method: "GET",
    url: `/api/assistant?projectId=${encodeURIComponent(projectId)}`,
    headers: { cookie },
  })

  assert.equal(response.statusCode, 200)
  assert.ok(response.json().write.includes("automations/**"))
})

test("automation definitions are loaded from project automations", async () => {
  const cookie = await login()
  const projectId = await createProject(cookie, "security-automation-definitions")
  await writeProjectFile(projectId, "automations/check.md", [
    "---",
    "title: Check automation",
    "tools: []",
    "---",
    "",
    "Do the check.",
    "",
  ].join("\n"))

  const response = await app.inject({
    method: "GET",
    url: `/api/automations?projectId=${encodeURIComponent(projectId)}`,
    headers: { cookie },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json().items.map((item) => item.title), ["Check automation"])
})

test("save_generated_markdown does not overwrite existing files", async () => {
  const cookie = await login()
  const projectId = await createProject(cookie, "security-generated-unique")
  const [generatedTool] = resolveAgentTools(["save_generated_markdown"], {
    projectId,
    read: [],
    write: ["generated/**"],
  })

  await generatedTool.invoke({ fileName: "report.md", content: "first" })
  await generatedTool.invoke({ fileName: "report.md", content: "second" })

  assert.equal(await fs.readFile(path.join(projectDir(projectId), "work", "report.md"), "utf8"), "first\n")
  assert.equal(await fs.readFile(path.join(projectDir(projectId), "work", "report-1.md"), "utf8"), "second\n")
})

test("ai tool logging summarizes payloads without raw content or secrets", () => {
  const summary = summarizeToolPayload({
    path: "work/report.md",
    content: "vault secret content",
    token: "real-token-value",
    nested: {
      file_path: "tasks/README.md",
      password: "real-password",
    },
  })
  const serialized = JSON.stringify(summary)

  assert.equal(summary.path, "work/report.md")
  assert.equal(summary.token, "[redacted]")
  assert.equal(summary.content.type, "string")
  assert.equal(summary.nested.file_path, "tasks/README.md")
  assert.equal(summary.nested.password, "[redacted]")
  assert.doesNotMatch(serialized, /vault secret content|real-token-value|real-password/)
})

test("automation write snapshots diff only declared write paths", async () => {
  const root = path.join(tempRoot, "automation-audit")
  await fs.mkdir(path.join(root, "work"), { recursive: true })
  await fs.mkdir(path.join(root, "resources"), { recursive: true })
  await fs.writeFile(path.join(root, "work", "existing.md"), "before\n", "utf8")
  await fs.writeFile(path.join(root, "resources", "ignored.md"), "before\n", "utf8")

  const before = await snapshotAutomationWritePaths(root, ["work/**"])

  await fs.writeFile(path.join(root, "work", "existing.md"), "after changed\n", "utf8")
  await fs.writeFile(path.join(root, "work", "new.md"), "new\n", "utf8")
  await fs.writeFile(path.join(root, "resources", "ignored.md"), "after changed\n", "utf8")

  const after = await snapshotAutomationWritePaths(root, ["work/**"])
  const diff = diffAutomationWriteSnapshots(before, after)

  assert.deepEqual(diff.added, ["work/new.md"])
  assert.deepEqual(diff.modified, ["work/existing.md"])
  assert.deepEqual(diff.deleted, [])
  assert.deepEqual(diff.changed, ["work/existing.md", "work/new.md"])
})
