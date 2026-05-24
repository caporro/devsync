import test from "node:test"
import assert from "node:assert/strict"
import {
  checkRateLimit,
  clearRateLimits,
  recordRateLimitHit,
  resetRateLimit,
} from "./rate-limit.js"

test("blocks after the configured number of hits until the window expires", () => {
  clearRateLimits()
  const options = { limit: 2, windowMs: 1000, now: 1000 }

  assert.equal(checkRateLimit("login:test", options).allowed, true)
  assert.equal(recordRateLimitHit("login:test", options).allowed, true)
  assert.equal(recordRateLimitHit("login:test", options).allowed, false)

  const blocked = checkRateLimit("login:test", { ...options, now: 1500 })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.retryAfterSeconds, 1)

  assert.equal(checkRateLimit("login:test", { ...options, now: 2100 }).allowed, true)
})

test("reset clears a blocked key", () => {
  clearRateLimits()
  const options = { limit: 1, windowMs: 1000, now: 1000 }

  recordRateLimitHit("mcp:test", options)
  assert.equal(checkRateLimit("mcp:test", options).allowed, false)

  resetRateLimit("mcp:test")
  assert.equal(checkRateLimit("mcp:test", options).allowed, true)
})
