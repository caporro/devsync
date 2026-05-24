const buckets = new Map()
const DEFAULT_MAX_BUCKETS = 5000

function nowMs(options = {}) {
  return Number(options.now ?? Date.now())
}

function retryAfterSeconds(resetAt, now) {
  return Math.max(1, Math.ceil((resetAt - now) / 1000))
}

function sweepExpired(now, maxBuckets = DEFAULT_MAX_BUCKETS) {
  if (buckets.size <= maxBuckets) {
    return
  }

  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key)
    }
  }
}

function rateState(bucket, limit, now) {
  if (!bucket || bucket.resetAt <= now) {
    return {
      allowed: true,
      remaining: limit,
      retryAfterSeconds: 0,
    }
  }

  const remaining = Math.max(0, limit - bucket.count)
  return {
    allowed: bucket.count < limit,
    remaining,
    retryAfterSeconds: remaining > 0 ? 0 : retryAfterSeconds(bucket.resetAt, now),
  }
}

export function checkRateLimit(key, options) {
  const now = nowMs(options)
  const limit = Number(options.limit)
  const bucket = buckets.get(String(key))

  if (bucket?.resetAt <= now) {
    buckets.delete(String(key))
    return rateState(null, limit, now)
  }

  return rateState(bucket, limit, now)
}

export function recordRateLimitHit(key, options) {
  const now = nowMs(options)
  const limit = Number(options.limit)
  const windowMs = Number(options.windowMs)
  const id = String(key)
  let bucket = buckets.get(id)

  if (!bucket || bucket.resetAt <= now) {
    bucket = {
      count: 0,
      resetAt: now + windowMs,
    }
    buckets.set(id, bucket)
  }

  bucket.count += 1
  sweepExpired(now, Number(options.maxBuckets ?? DEFAULT_MAX_BUCKETS))
  return rateState(bucket, limit, now)
}

export function resetRateLimit(key) {
  buckets.delete(String(key))
}

export function clearRateLimits() {
  buckets.clear()
}
