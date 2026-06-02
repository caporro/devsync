const streams = new Map()
const TERMINAL_EVENTS = new Set(["run_completed", "error"])
const CLEANUP_MS = 5 * 60 * 1000

function getStream(runId, metadata = {}) {
  let stream = streams.get(runId)

  if (!stream) {
    stream = {
      events: [],
      listeners: new Set(),
      terminal: false,
      cleanupTimer: null,
      threadId: metadata.threadId ?? null,
      userKey: metadata.userKey ?? null,
    }
    streams.set(runId, stream)
  } else {
    stream.threadId = stream.threadId ?? metadata.threadId ?? null
    stream.userKey = stream.userKey ?? metadata.userKey ?? null
  }

  if (stream.cleanupTimer) {
    clearTimeout(stream.cleanupTimer)
    stream.cleanupTimer = null
  }

  return stream
}

function scheduleCleanup(runId, stream) {
  stream.cleanupTimer = setTimeout(() => {
    streams.delete(runId)
  }, CLEANUP_MS)
}

function canUseStream(stream, metadata = {}) {
  if (stream.userKey && metadata.userKey && stream.userKey !== metadata.userKey) {
    return false
  }

  if (stream.threadId && metadata.threadId && stream.threadId !== metadata.threadId) {
    return false
  }

  return true
}

export function createAgentRunStream(runId, metadata = {}) {
  getStream(runId, metadata)
}

export function appendAgentRunEvent(runId, event, data) {
  const stream = getStream(runId)
  const record = { event, data }

  stream.events.push(record)
  for (const listener of stream.listeners) {
    listener(record)
  }

  if (TERMINAL_EVENTS.has(event)) {
    stream.terminal = true
    scheduleCleanup(runId, stream)
  }
}

export function canSubscribeToAgentRunStream(runId, metadata = {}) {
  const stream = streams.get(runId)

  if (!stream) {
    return "missing"
  }

  return canUseStream(stream, metadata) ? "ok" : "forbidden"
}

export function subscribeToAgentRunStream(runId, metadata = {}, listener) {
  const stream = streams.get(runId)

  if (!stream) {
    return null
  }

  if (!canUseStream(stream, metadata)) {
    return {
      terminal: true,
      unauthorized: true,
      unsubscribe: () => undefined,
    }
  }

  for (const event of stream.events) {
    listener(event)
  }

  if (stream.terminal) {
    return {
      terminal: true,
      unsubscribe: () => undefined,
    }
  }

  stream.listeners.add(listener)

  return {
    terminal: false,
    unsubscribe: () => {
      const current = streams.get(runId)
      if (!current) {
        return
      }

      current.listeners.delete(listener)
      if (current.terminal && current.listeners.size === 0) {
        scheduleCleanup(runId, current)
      }
    },
  }
}
