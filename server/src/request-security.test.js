import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { createRequestGuard } from "./request-security.js"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-http-security-"))
Object.assign(process.env, {
  NODE_ENV: "test", AUTH_MODE: "none", DEVSYNC_API_TOKEN: "",
  DEVSYNC_DATA_ROOT: root, DEVSYNC_DATA_DIR: "", DEVSYNC_VAULT_NAME: "http-security",
  DEVSYNC_WEB_DIST: path.join(root, "web"), DEVSYNC_PUBLIC_URL: "https://devsync.example",
})
await fs.mkdir(process.env.DEVSYNC_WEB_DIST)
await fs.writeFile(path.join(process.env.DEVSYNC_WEB_DIST, "index.html"), "<!doctype html><html></html>")
const { app } = await import("./index.js")
const { createProject, dataDir } = await import("./storage.js")
await createProject({ name: "probe" })
after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }) })

test("local anonymous APIs reject DNS rebinding hosts", async () => {
  const response = await app.inject({ method: "GET", url: "/api/projects", headers: { host: "attacker.example:4000", origin: "http://attacker.example:4000" } })
  assert.equal(response.statusCode, 403)
})

test("API and MCP reject untrusted and opaque browser origins", async () => {
  for (const url of ["/api/projects", "/%61pi/projects", "/mcp"]) {
    for (const origin of ["https://attacker.example", "null", "http://localhost:4999"]) {
      const response = await app.inject({ method: "POST", url, headers: { host: "localhost:4000", origin, accept: "application/json, text/event-stream" }, payload: { name: "forbidden", jsonrpc: "2.0", id: 1, method: "tools/list" } })
      assert.equal(response.statusCode, 403, `${url} / ${origin}`)
    }
  }
})

test("cross-site simple multipart requests cannot upload files", async () => {
  const boundary = "devsync-boundary"
  const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cross-site.txt"\r\nContent-Type: text/plain\r\n\r\nUntrusted upload\r\n--${boundary}--\r\n`
  const response = await app.inject({ method: "POST", url: "/api/projects/probe/resources/upload", headers: { host: "localhost:4000", origin: "https://attacker.example", "content-type": `multipart/form-data; boundary=${boundary}` }, payload })
  assert.equal(response.statusCode, 403)
  assert.deepEqual(await fs.readdir(path.join(dataDir, "probe", "resources")), [])
})

test("same-origin UI, configured HTTPS reverse proxy and clients without Origin remain usable", async () => {
  for (const headers of [{ host: "127.0.0.1:4000", origin: "http://127.0.0.1:4000" }, { host: "localhost:5173", origin: "http://localhost:5173" }, { host: "devsync.example", origin: "https://devsync.example" }, { host: "localhost:4000" }]) {
    const response = await app.inject({ method: "GET", url: "/api/projects", headers })
    assert.equal(response.statusCode, 200)
  }
})

test("cross-site fetch metadata without an Origin cannot reach operational APIs", async () => {
  const response = await app.inject({ method: "GET", url: "/api/projects", headers: { host: "localhost:4000", "sec-fetch-site": "cross-site" } })
  assert.equal(response.statusCode, 403)
})

test("explicit origins are exact and forwarded headers cannot grant trust", () => {
  const guard = createRequestGuard({ authMode: "none", allowedOrigins: "https://client.example" })
  const request = (headers) => ({ protocol: "http", routeOptions: { url: "/mcp" }, headers: { host: "localhost:4000", ...headers } })
  assert.equal(guard(request({ origin: "https://client.example" })), null)
  for (const origin of ["https://client.example.attacker.example", "https://client.example:444", "https://client.example/path", "file:///tmp/page", "https://attacker.example"]) {
    assert.ok(guard(request({ origin, "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" })), origin)
  }
  assert.ok(guard(request({ host: "attacker.example", origin: "https://client.example", "x-forwarded-host": "localhost:4000" })))
})

test("rejected nested folder writes leave no directories outside the vault", async () => {
  const { createDocument } = await import("./storage.js")
  const outside = path.join(root, "outside")
  await fs.mkdir(outside)
  const link = path.join(dataDir, "probe", "resources", "escape")
  await fs.symlink(outside, link)
  try {
    await assert.rejects(createDocument({ projectId: "probe", folder: "escape/created-outside", title: "Escape", content: "Blocked write" }), { statusCode: 400 })
    assert.deepEqual(await fs.readdir(outside), [])
  } finally { await fs.unlink(link) }
})
