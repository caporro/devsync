const streams = new Map()
const TERMINAL_EVENTS = new Set(["run_completed", "error"])
const CLEANUP_MS = 5 * 60 * 1000

function getStream(runId) {
  let stream = streams.get(runId)

  if (!stream) {
    stream = {
      events: [],
      listeners: new Set(),
      terminal: false,
      cleanupTimer: null,
    }
    streams.set(runId, stream)
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

export function createAgentRunStream(runId) {
  getStream(runId)
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

export function subscribeToAgentRunStream(runId, listener) {
  const stream = streams.get(runId)

  if (!stream) {
    return null
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
