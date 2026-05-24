import { BaseCallbackHandler } from "@langchain/core/callbacks/base"

const SECRET_KEY_PATTERN = /(token|secret|password|credential|authorization|api[_-]?key|access[_-]?key|session)/i
const PATH_KEYS = new Set([
  "dir_path",
  "filePath",
  "file_path",
  "path",
  "source_path",
  "target_path",
])
const SAFE_VALUE_KEYS = new Set(["code", "count", "exitCode", "mimeType", "ok", "size", "status"])

function summarizeString(value) {
  return {
    type: "string",
    chars: value.length,
    bytes: Buffer.byteLength(value, "utf8"),
  }
}

function summarizeArray(value) {
  return {
    type: "array",
    count: value.length,
  }
}

function summarizeObject(value, depth = 0) {
  const output = {
    type: "object",
    keys: Object.keys(value).slice(0, 20),
  }

  if (depth > 1) {
    return output
  }

  for (const [key, raw] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = "[redacted]"
    } else if (PATH_KEYS.has(key) && typeof raw === "string") {
      output[key] = raw
    } else if (SAFE_VALUE_KEYS.has(key) && ["boolean", "number", "string"].includes(typeof raw)) {
      output[key] = raw
    } else if (typeof raw === "string") {
      output[key] = summarizeString(raw)
    } else if (Array.isArray(raw)) {
      output[key] = summarizeArray(raw)
    } else if (raw && typeof raw === "object") {
      output[key] = summarizeObject(raw, depth + 1)
    }
  }

  return output
}

export function summarizeToolPayload(value) {
  if (value === null || value === undefined) {
    return { type: String(value) }
  }

  if (typeof value === "string") {
    return summarizeString(value)
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value
  }

  if (Array.isArray(value)) {
    return summarizeArray(value)
  }

  if (typeof value === "object") {
    return summarizeObject(value)
  }

  return { type: typeof value }
}

export class AiToolLogHandler extends BaseCallbackHandler {
  name = "devsync_ai_tool_log_handler"

  constructor(log, context = {}) {
    super()
    this.log = log
    this.context = context
  }

  handleToolStart(toolInfo, input, runId, _parentRunId, _tags, _metadata, runName) {
    this.log?.info({
      ...this.context,
      toolRunId: runId,
      tool: runName ?? toolInfo?.name ?? "tool",
      input: summarizeToolPayload(input),
    }, "ai tool start")
  }

  handleToolEnd(output, runId) {
    this.log?.info({
      ...this.context,
      toolRunId: runId,
      output: summarizeToolPayload(output),
    }, "ai tool end")
  }

  handleToolError(error, runId) {
    this.log?.error({
      ...this.context,
      toolRunId: runId,
      error: {
        name: error?.name ?? "Error",
        message: error instanceof Error ? error.message : String(error),
        cause: error?.cause instanceof Error ? error.cause.message : error?.cause ? String(error.cause) : undefined,
      },
    }, "ai tool error")
  }
}
