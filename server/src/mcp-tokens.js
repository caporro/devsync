import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { dataRootDir, vaultName } from "./storage.js"

const TOKEN_DIR = path.join(dataRootDir, "auth", vaultName)
const TOKEN_FILE = path.join(TOKEN_DIR, "mcp-tokens.json")
const TOKEN_PREFIX = "devsync_mcp"

function nowIso() {
  return new Date().toISOString()
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("base64url")
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function publicToken(item) {
  return {
    id: item.id,
    name: item.name,
    userEmail: item.userEmail,
    userName: item.userName,
    prefix: item.prefix,
    createdAt: item.createdAt,
    lastUsedAt: item.lastUsedAt ?? null,
  }
}

async function readStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"))
    return {
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return { tokens: [] }
    }
    throw error
  }
}

async function writeStore(store) {
  await fs.mkdir(TOKEN_DIR, { recursive: true })
  const tmp = `${TOKEN_FILE}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8")
  await fs.rename(tmp, TOKEN_FILE)
}

export async function listMcpTokensForUser(user) {
  const email = String(user?.email ?? user?.username ?? "").trim().toLowerCase()
  const store = await readStore()

  return store.tokens
    .filter((item) => item.userEmail === email)
    .map(publicToken)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export async function createMcpTokenForUser(user, input = {}) {
  const email = String(user?.email ?? user?.username ?? "").trim().toLowerCase()
  const userName = String(user?.name ?? email).trim() || email

  if (!email) {
    throw Object.assign(new Error("Authenticated user required"), { statusCode: 401 })
  }

  const id = crypto.randomUUID()
  const secret = crypto.randomBytes(32).toString("base64url")
  const token = `${TOKEN_PREFIX}_${id}.${secret}`
  const name = String(input.name ?? "").trim().slice(0, 80) || "Codex"
  const createdAt = nowIso()
  const item = {
    id,
    name,
    userEmail: email,
    userName,
    prefix: token.slice(0, 22),
    tokenHash: hashToken(token),
    createdAt,
    lastUsedAt: null,
  }
  const store = await readStore()

  store.tokens.push(item)
  await writeStore(store)

  return {
    token,
    item: publicToken(item),
  }
}

export async function deleteMcpTokenForUser(user, tokenId) {
  const email = String(user?.email ?? user?.username ?? "").trim().toLowerCase()
  const store = await readStore()
  const before = store.tokens.length

  store.tokens = store.tokens.filter((item) => !(item.id === tokenId && item.userEmail === email))

  if (store.tokens.length === before) {
    throw Object.assign(new Error("Token not found"), { statusCode: 404 })
  }

  await writeStore(store)

  return { ok: true }
}

export async function verifyMcpToken(token) {
  const value = String(token ?? "").trim()

  if (!value.startsWith(`${TOKEN_PREFIX}_`)) {
    return null
  }

  const store = await readStore()
  const expected = hashToken(value)
  const item = store.tokens.find((candidate) => safeEqual(candidate.tokenHash, expected))

  if (!item) {
    return null
  }

  item.lastUsedAt = nowIso()
  await writeStore(store)

  return {
    username: item.userEmail,
    email: item.userEmail,
    name: item.userName,
    authMode: "mcp-token",
  }
}
