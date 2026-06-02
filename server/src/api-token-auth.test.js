import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-api-token-auth-"))
const webDist = path.join(tempRoot, "web-dist")

process.env.NODE_ENV = "test"
process.env.DEVSYNC_DATA_ROOT = tempRoot
process.env.DEVSYNC_VAULT_NAME = "api-token-vault"
process.env.DEVSYNC_WEB_DIST = webDist
process.env.AUTH_MODE = "none"
process.env.DEVSYNC_API_TOKEN = "test-api-token"

await fs.mkdir(webDist, { recursive: true })
await fs.writeFile(path.join(webDist, "index.html"), "<!doctype html><html></html>\n", "utf8")

const { app } = await import("./index.js")

after(async () => {
  await app.close()
  await fs.rm(tempRoot, { recursive: true, force: true })
})

test("API token protects APIs when password auth is disabled", async () => {
  const withoutToken = await app.inject({
    method: "GET",
    url: "/api/projects",
  })

  assert.equal(withoutToken.statusCode, 401)

  const meWithoutToken = await app.inject({
    method: "GET",
    url: "/api/auth/me",
  })

  assert.equal(meWithoutToken.statusCode, 401)

  const loginWithoutToken = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: {
      "content-type": "application/json",
    },
    payload: JSON.stringify({ email: "team", password: "ignored" }),
  })

  assert.equal(loginWithoutToken.statusCode, 401)

  const withToken = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: {
      authorization: "Bearer test-api-token",
    },
  })

  assert.equal(withToken.statusCode, 200)

  const meWithToken = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: {
      authorization: "Bearer test-api-token",
    },
  })

  assert.equal(meWithToken.statusCode, 200)
  assert.equal(meWithToken.json().user.authMode, "api-token")

  const loginWithToken = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: {
      authorization: "Bearer test-api-token",
      "content-type": "application/json",
    },
    payload: JSON.stringify({}),
  })

  assert.equal(loginWithToken.statusCode, 200)
  assert.equal(loginWithToken.json().user.authMode, "api-token")
})
