import crypto from "node:crypto"

const COOKIE_NAME = "devsync_session"
const DEFAULT_SESSION_DAYS = 7
const HASH_ALGORITHM = "scrypt"
const SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  keyLength: 64,
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url")
}

function parseBase64Url(input) {
  return Buffer.from(input, "base64url")
}

function hmac(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url")
}

function safeEqualString(left, right) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function parseCookieHeader(header = "") {
  const cookies = new Map()

  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index === -1) {
      continue
    }

    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()

    if (name) {
      try {
        cookies.set(name, decodeURIComponent(value))
      } catch {
        cookies.set(name, value)
      }
    }
  }

  return cookies
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"]

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`)
  }

  if (options.secure) {
    parts.push("Secure")
  }

  return parts.join("; ")
}

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      params.keyLength,
      {
        N: params.N,
        r: params.r,
        p: params.p,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error)
          return
        }

        resolve(derivedKey)
      }
    )
  })
}

function parsePasswordHash(hash) {
  const parts = hash.split("$")

  if (parts.length !== 7 || parts[0] !== HASH_ALGORITHM) {
    throw new Error("Unsupported password hash format")
  }

  const params = {
    N: Number(parts[1]),
    r: Number(parts[2]),
    p: Number(parts[3]),
    keyLength: Number(parts[4]),
  }

  if (!params.N || !params.r || !params.p || !params.keyLength || !parts[5] || !parts[6]) {
    throw new Error("Invalid password hash")
  }

  return {
    params,
    salt: parseBase64Url(parts[5]),
    hash: parseBase64Url(parts[6]),
  }
}

function parseAuthUsers(raw) {
  const users = new Map()

  for (const entry of String(raw ?? "").split(",")) {
    const value = entry.trim()

    if (!value) {
      continue
    }

    if (value.includes("|")) {
      const [emailValue, nameValue, hashValue] = value.split("|")
      const email = emailValue?.trim().toLowerCase()
      const name = nameValue?.trim()
      const hash = hashValue?.trim()

      if (!email || !email.includes("@") || !name || !hash) {
        throw new Error("AUTH_USERS entries must use email|name|hash")
      }

      parsePasswordHash(hash)
      users.set(email, { email, name, hash })
      continue
    }

    const separator = value.indexOf(":")
    const username = value.slice(0, separator).trim().toLowerCase()
    const hash = value.slice(separator + 1).trim()

    if (separator <= 0 || !username || !hash) {
      throw new Error("AUTH_USERS entries must use email|name|hash")
    }

    parsePasswordHash(hash)
    users.set(username, { email: username, name: username, hash })
  }

  return users
}

function publicUser(user, authMode) {
  const email = user.email ?? user.username ?? "team"
  const name = user.name ?? email

  return {
    username: email,
    email,
    name,
    authMode,
  }
}

export function createPasswordHash(password) {
  const salt = crypto.randomBytes(16)

  return scrypt(password, salt, SCRYPT_PARAMS).then((hash) =>
    [
      HASH_ALGORITHM,
      SCRYPT_PARAMS.N,
      SCRYPT_PARAMS.r,
      SCRYPT_PARAMS.p,
      SCRYPT_PARAMS.keyLength,
      salt.toString("base64url"),
      hash.toString("base64url"),
    ].join("$")
  )
}

export function createAuth() {
  const defaultAuthMode = String(process.env.DEVSYNC_SELF_HOSTED ?? "").toLowerCase() === "true"
    ? "password"
    : "none"
  const authMode = String(process.env.AUTH_MODE ?? process.env.DEVSYNC_AUTH_MODE ?? defaultAuthMode).trim()
  const sessionSecret = String(process.env.AUTH_SESSION_SECRET ?? process.env.DEVSYNC_AUTH_SESSION_SECRET ?? "")
  const sessionSeconds = Math.max(60, Number(process.env.AUTH_SESSION_SECONDS ?? DEFAULT_SESSION_DAYS * 24 * 60 * 60))
  const secureCookie = String(process.env.AUTH_COOKIE_SECURE ?? "").toLowerCase() === "true"

  if (!["none", "password"].includes(authMode)) {
    throw new Error(`Unsupported AUTH_MODE: ${authMode}`)
  }

  if (authMode === "none") {
    return {
      mode: authMode,
      isEnabled: false,
      currentUser: () => publicUser({ email: "team", name: "team" }, authMode),
      users: () => [publicUser({ email: "team", name: "team" }, authMode)],
      async login() {
        return publicUser({ email: "team", name: "team" }, authMode)
      },
      logout(reply) {
        reply.header("Set-Cookie", serializeCookie(COOKIE_NAME, "", { maxAge: 0, secure: secureCookie }))
      },
      setSession() {},
    }
  }

  if (sessionSecret.length < 32) {
    throw new Error("AUTH_SESSION_SECRET must be at least 32 characters when AUTH_MODE=password")
  }

  const users = parseAuthUsers(process.env.AUTH_USERS ?? process.env.DEVSYNC_AUTH_USERS)

  if (users.size === 0) {
    throw new Error("AUTH_USERS must contain at least one email|name|hash entry when AUTH_MODE=password")
  }

  function createSession(username) {
    const now = Math.floor(Date.now() / 1000)
    const payload = base64Url(JSON.stringify({ sub: username, iat: now, exp: now + sessionSeconds }))
    return `${payload}.${hmac(payload, sessionSecret)}`
  }

  function readSession(request) {
    const cookie = parseCookieHeader(request.headers.cookie).get(COOKIE_NAME)

    if (!cookie) {
      return null
    }

    const [payload, signature] = cookie.split(".")

    if (!payload || !signature || !safeEqualString(hmac(payload, sessionSecret), signature)) {
      return null
    }

    try {
      const session = JSON.parse(parseBase64Url(payload).toString("utf8"))
      const username = String(session.sub ?? "").toLowerCase()
      const user = users.get(username)

      if (!username || !user || Number(session.exp) < Math.floor(Date.now() / 1000)) {
        return null
      }

      return publicUser(user, authMode)
    } catch {
      return null
    }
  }

  function setSession(reply, username) {
    reply.header(
      "Set-Cookie",
      serializeCookie(COOKIE_NAME, createSession(username), {
        maxAge: sessionSeconds,
        secure: secureCookie,
      })
    )
  }

  return {
    mode: authMode,
    isEnabled: true,
    currentUser: readSession,
    users: () => [...users.values()].map((user) => publicUser(user, authMode)),
    async login(username, password) {
      const user = users.get(String(username ?? "").trim().toLowerCase())

      if (!user) {
        return null
      }

      const parsed = parsePasswordHash(user.hash)
      const actual = await scrypt(password, parsed.salt, parsed.params)

      if (actual.length !== parsed.hash.length || !crypto.timingSafeEqual(actual, parsed.hash)) {
        return null
      }

      return publicUser(user, authMode)
    },
    logout(reply) {
      reply.header("Set-Cookie", serializeCookie(COOKIE_NAME, "", { maxAge: 0, secure: secureCookie }))
    },
    setSession,
  }
}
